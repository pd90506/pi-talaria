// Projects (`extensions/talaria-projects.ts`): making a project over HTTP makes its folder, its files, and its
// coordinator session; the coordinator's prompt says what it is; it starts threads only in the project's folders, and
// gets each thread's report by itself.
import {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";

const pip = join(root, "pip");

process.env.PI_TALARIA_PIP_DIR = pip;

/** Every request the model got, as JSON. */
const requests: string[] = [];
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const tokens: Record<string, string> = {};

before(async () => {
    mkdirSync(work, { recursive: true });
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        requests.push(JSON.stringify(request));

        if (role === "user" && text.includes("START_THREAD")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("project_thread", {
                        action: "start",
                        folder: work,
                        title: "Count",
                        message: "Count the files.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text.includes("BAD_THREAD")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("project_thread", {
                        action: "start",
                        folder: root,
                        message: "Look around.",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        return fauxAssistantMessage([fauxText("Done: 3 files.")]);
    });

    app = await openApp(model);
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tokens.owner = app.config.ownerToken;
    tokens.guest = app.config.addUser("Gale", "guest").token;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function call(who: string, path: string, body?: unknown) {
    const response = await fetch(`${base}/api/x/talaria-projects/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${tokens[who]!}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

let coordinator: ConversationId;

test("the owner makes a project: its folder, project.json, AGENTS.md, and a coordinator session there", async () => {
    const made = await call("owner", "projects", { name: "My App", folders: [work] });

    assert.equal(made.status, 200);
    assert.equal(made.data.id, "my-app");
    const folder = join(pip, "projects", "my-app");

    assert.equal(made.data.folder, folder);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "project.json"), "utf8")), {
        name: "My App",
        folders: [work],
    });
    assert.match(readFileSync(join(folder, "AGENTS.md"), "utf8"), /^# My App/);
    coordinator = made.data.coordinator as unknown as ConversationId;
    const session = app.sessions().find((each) => each.id === Number(coordinator));

    assert.ok(session, "the coordinator session");
    assert.equal(session.title, "My App");

    // The same name again gets a folder of its own.
    const again = await call("owner", "projects", { name: "My App" });

    assert.equal(again.data.id, "my-app-2");

    const listed = await call("owner", "projects");
    const projects = listed.data.projects as { id: string; name: string }[];

    assert.deepEqual(projects.map((each) => each.id).sort(), ["my-app", "my-app-2"]);
});

test("only the owner makes and lists projects; a bad name or folder makes nothing", async () => {
    assert.equal((await call("guest", "projects")).status, 404);
    assert.equal((await call("guest", "projects", { name: "Theirs" })).status, 404);
    assert.equal((await call("owner", "projects", { name: "  " })).status, 400);

    const missing = await call("owner", "projects", {
        name: "Elsewhere",
        folders: ["/no/such/folder"],
    });

    assert.equal(missing.status, 400);
    assert.equal(existsSync(join(pip, "projects", "elsewhere")), false);
});

test("the coordinator's prompt says it coordinates the project, and its thread starts in the project's folder", async () => {
    await app.commands.configure(coordinator, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    requests.length = 0;
    await say(app, coordinator, "START_THREAD");

    assert.match(requests.join("\n"), /You are the coordinator of the project \\"My App\\"/);
    const thread = app.sessions().find((each) => each.linkedFrom?.id === Number(coordinator));

    assert.ok(thread, "a thread");
    assert.equal(thread.cwd, work);
    await until(
        async () =>
            (await modelTexts(app, thread.id as never)).some((text) =>
                /You are a thread of the project \\*"My App/.test(text),
            ),
        "the thread's brief",
    );
    const brief = (await modelTexts(app, thread.id as never)).join("\n");

    assert.match(brief, /with the background tool, or give long work to a subagent/);
    assert.match(brief, /Count the files\./);

    // The thread's final answer comes back to the coordinator by itself.
    await until(
        async () =>
            (await modelTexts(app, coordinator)).some((text) => text.includes("Done: 3 files.")),
        "the thread's report",
    );
});

test("a thread outside the project's folders is refused, and a session outside a project has no threads", async () => {
    await say(app, coordinator, "BAD_THREAD");
    assert.match(
        (await modelTexts(app, coordinator)).join("\n"),
        /is not one of this project's folders/,
    );

    const plain = await newSession(app);

    await say(app, plain, "START_THREAD");
    assert.match(
        (await modelTexts(app, plain)).join("\n"),
        /works only in a project's coordinator session/,
    );
    assert.equal(
        app.sessions().some((each) => each.linkedFrom?.id === Number(plain)),
        false,
    );
});
