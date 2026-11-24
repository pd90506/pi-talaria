// Projects (`extensions/talaria-projects.ts`): PiP alone has the projects tool; a create makes the folder, its files,
// and one coordinator session working there, and a replay makes no second one; Agent Teams is on, so the coordinator
// can start threads; the page's routes list projects with their threads and make new ones.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ProjectsDoc, slugOf } from "../src/server/extensions/talaria-projects.ts";
import { createHandler } from "../src/server/http.ts";

const pipDir = join(root, "pip");

process.env.PI_TALARIA_PIP_DIR = pipDir;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    const [verb = "", ...rest] = text.replace(/^\[from: [^\]]+\] /, "").split(" ");

    if (verb === "call") {
        const [name = "", ...json] = rest;

        return fauxAssistantMessage(
            [fauxToolCall(name, JSON.parse(json.join(" ")) as Parameters<typeof fauxToolCall>[1])],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const dataDir = join(root, "projects-data");
let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(scriptedModel(route), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

const toolsOf = async (conversation: ConversationId) =>
    (await (await app.conversation(conversation)).agent(context)).tools.map((each) => each.name);

const projects = async () => (await app.harness.snapshot(ProjectsDoc, context))?.items ?? {};

async function api(path: string, body?: unknown) {
    const response = await fetch(`${base}/api/x/talaria-projects/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as unknown };
}

test("folder names keep letters of any script", () => {
    assert.equal(slugOf("Talaria Agent"), "talaria-agent");
    assert.equal(slugOf("个人 助理!"), "个人-助理");
    assert.throws(() => slugOf("!!"), /letter or a digit/);
});

test("only PiP has the projects tool", async () => {
    const id = await pip();
    const session = await newSession(app);

    assert.ok((await toolsOf(id)).includes("projects"));
    assert.ok(!(await toolsOf(session)).includes("projects"));
});

test("PiP makes a project: its folder, its files, and one coordinator working there", async () => {
    const id = await pip();
    const args = {
        action: "create",
        name: "Home Lab",
        purpose: "Keep the NUC running.",
        folders: ["~/repo/lab"],
    };

    await say(app, id, `call projects ${JSON.stringify(args)}`);

    const project = (await projects())["home-lab"];

    assert.ok(project !== undefined);
    assert.equal(project.folder, join(pipDir, "projects", "home-lab"));
    assert.equal(project.status, "active");
    assert.ok(existsSync(join(pipDir, "home")));
    assert.ok(existsSync(join(project.folder, "memory")));
    assert.match(
        readFileSync(join(project.folder, "AGENTS.md"), "utf8"),
        /coordinator[\s\S]*thread 规则/,
    );
    assert.deepEqual(
        JSON.parse(readFileSync(join(project.folder, "project.json"), "utf8")).folders,
        ["~/repo/lab"],
    );

    const coordinator = project.coordinator as unknown as ConversationId;

    assert.equal(app.cwdOf(coordinator), project.folder);
    assert.equal(app.sessionMeta(coordinator)?.title, "Home Lab");
    // Agent Teams is on by default: the coordinator can start threads.
    assert.ok((await toolsOf(coordinator)).includes("team"));

    // A second create of the same name makes nothing new.
    const before = app.sessions().length;

    await say(app, id, `call projects ${JSON.stringify(args)}`);
    assert.equal(app.sessions().length, before);
    assert.equal(Object.keys(await projects()).length, 1);

    await say(app, id, `call projects ${JSON.stringify({ action: "list" })}`);
    const entries = await app.transcripts.allEntries(id, true);
    const last = JSON.stringify(entries.at(-1));

    assert.match(last, /home-lab: \[Home Lab\]\(\/s\/\d+\) · active/);
});

test("the page lists projects with their threads, and makes new ones", async () => {
    const made = await api("projects", { name: "Writing", purpose: "", folders: [] });

    assert.equal(made.status, 200);
    const project = made.body as { id: string; coordinator: number; folder: string };

    assert.equal(project.id, "writing");
    assert.equal(app.cwdOf(project.coordinator as unknown as ConversationId), project.folder);
    assert.equal((await api("projects", { name: "writing" })).status, 409);
    assert.equal((await api("projects", { name: " " })).status, 400);

    const listed = (await api("projects")).body as { id: string; threads: unknown[] }[];

    assert.deepEqual(listed.map((each) => each.id).sort(), ["home-lab", "writing"]);
    assert.ok(listed.every((each) => Array.isArray(each.threads)));
});
