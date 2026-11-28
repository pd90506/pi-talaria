// Develop (Versions → Develop, `talaria-develop.ts`): the project for developing pi-talaria is made once, on the
// person's GitHub copy of it (pi-talaria itself when they can push to it, else their fork); its coordinator speaks
// first and asks which checkout to use, then binds one or clones the repository with project_repo.
import {
    cleanUp,
    home,
    lastText,
    modelTexts,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { writeSource } from "../src/server/releases.ts";
import { githubCopy } from "../src/server/talaria-develop.ts";
import type { Gh } from "../src/server/github.ts";

const pip = join(root, "pip");

process.env.PI_TALARIA_PIP_DIR = pip;
process.env.HOME = home;

// GitHub, as this machine's gh and git see it: a gh that says the owner can push to pi-talaria, and git that fetches
// "https://github.com/…" from bare repositories here.
const bin = join(root, "bin");
const github = join(root, "github");
const ghLog = join(root, "gh.log");

mkdirSync(bin, { recursive: true });
writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> ${JSON.stringify(ghLog)}
case "$*" in
  "api user --jq .login") echo pd90506 ;;
  "api repos/pd90506/pi-talaria") echo '{"full_name":"pd90506/pi-talaria","default_branch":"main","permissions":{"push":true}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = `url.${github}/.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";

const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// pi-talaria "on GitHub", and the owner's checkout of it, which the release source names as its seed.
const bare = join(github, "pd90506", "pi-talaria.git");
const checkout = join(home, "repo", "pi-talaria");

mkdirSync(checkout, { recursive: true });
run(checkout, "init", "--quiet", "-b", "main");
writeFileSync(join(checkout, "README.md"), "pi-talaria\n");
run(checkout, "add", ".");
run(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "one",
);
mkdirSync(join(github, "pd90506"), { recursive: true });
run(root, "clone", "--quiet", "--bare", checkout, bare);
run(checkout, "remote", "add", "origin", "https://github.com/pd90506/pi-talaria.git");

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const clone = join(home, "code", "pi-talaria-2");

before(async () => {
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);
        const call = (name: string, args: Record<string, unknown>) =>
            fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

        if (role === "user" && text.includes("pressed Develop")) {
            return call("project_repo", { action: "find" });
        }

        if (role === "user" && text.includes("BIND_IT")) {
            return call("project_repo", { action: "bind", folder: "~/repo/pi-talaria" });
        }

        if (role === "user" && text.includes("BIND_ELSEWHERE")) {
            return call("project_repo", { action: "bind", folder: root });
        }

        if (role === "user" && text.includes("CLONE_IT")) {
            return call("project_repo", { action: "clone", folder: clone });
        }

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        return fauxAssistantMessage([fauxText("ok")]);
    });

    app = await openApp(model);
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    writeSource(app.dataDir, {
        v: 1,
        url: "https://github.com/pd90506/pi-talaria.git",
        branch: "main",
        seed: checkout,
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function develop() {
    const response = await fetch(`${base}/api/x/talaria-projects/develop`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: "{}",
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

const projectJson = (folder: string) =>
    JSON.parse(readFileSync(join(folder, "project.json"), "utf8")) as Record<string, unknown>;

let coordinator: ConversationId;
let folder = "";

test("Develop makes the pi-talaria project on the repository the owner can push to, and its coordinator asks first", async () => {
    const made = await develop();

    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.equal(made.data.name, "Develop pi-talaria");
    assert.equal(made.data.repository, "pd90506/pi-talaria");
    assert.equal(made.data.forked, false);
    folder = made.data.folder as string;
    coordinator = made.data.coordinator as unknown as ConversationId;
    assert.deepEqual(projectJson(folder), {
        name: "Develop pi-talaria",
        folders: [],
        repository: "pd90506/pi-talaria",
    });
    assert.match(readFileSync(join(folder, "AGENTS.md"), "utf8"), /Versions → Update/);
    // No fork: the owner can push to pi-talaria.
    assert.doesNotMatch(readFileSync(ghLog, "utf8"), /fork/);

    // The coordinator speaks first, with the checkouts found, and looks for them itself.
    await until(
        async () =>
            (await modelTexts(app, coordinator)).some((text) =>
                text.includes("Checkouts on this machine"),
            ),
        "the coordinator's first look",
    );
    const said = (await modelTexts(app, coordinator)).join("\n");

    assert.match(said, /pressed Develop in Versions/);
    assert.match(said, /ask tool/);
    assert.ok(said.includes(`Checkouts found on this machine: ${checkout}`), said);
    assert.ok(said.includes(join(home, "repo", "pi-talaria")), "the suggested place");

    // Develop again opens the same project.
    const again = await develop();

    assert.equal(again.data.id, made.data.id);
    assert.equal(again.data.existing, true);
});

test("the coordinator binds a checkout of the repository, and only one", async () => {
    await say(app, coordinator, "BIND_ELSEWHERE");
    assert.equal(projectJson(folder).checkout, undefined);
    assert.match(
        (await modelTexts(app, coordinator)).join("\n"),
        /is inside the checkout|is not a git checkout/,
    );

    await say(app, coordinator, "BIND_IT");
    const file = projectJson(folder);

    assert.equal(file.checkout, checkout);
    assert.deepEqual(file.folders, [checkout]);

    // Its prompt says where the code is now.
    const requests = JSON.stringify(await modelTexts(app, coordinator));

    assert.match(requests, /Bound pd90506\/pi-talaria/);
});

test("the coordinator clones the repository to a new place, from the local checkout, pointed at GitHub", async () => {
    await say(app, coordinator, "CLONE_IT");

    assert.ok(existsSync(join(clone, "README.md")), "the clone");
    assert.equal(
        run(clone, "config", "remote.origin.url"),
        "https://github.com/pd90506/pi-talaria.git",
    );
    assert.equal(run(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    const file = projectJson(folder);

    assert.equal(file.checkout, clone);
    assert.deepEqual(file.folders, [checkout, clone]);
});

test("someone who cannot push to pi-talaria gets their fork, made once", async () => {
    const calls: string[] = [];
    let forked = false;

    const gh: Gh = async (args) => {
        const line = args.join(" ");

        calls.push(line);

        if (line === "api user --jq .login") {
            return "gale\n";
        }

        if (line === "api repos/pd90506/pi-talaria") {
            return JSON.stringify({
                full_name: "pd90506/pi-talaria",
                permissions: { push: false },
            });
        }

        if (line === "api repos/gale/pi-talaria") {
            if (!forked) {
                throw new Error("HTTP 404: Not Found");
            }

            return JSON.stringify({
                full_name: "gale/pi-talaria",
                fork: true,
                parent: { full_name: "pd90506/pi-talaria" },
            });
        }

        if (line.startsWith("repo fork pd90506/pi-talaria")) {
            forked = true;

            return "";
        }

        throw new Error(`unexpected: ${line}`);
    };

    const wait = async () => {};

    assert.deepEqual(await githubCopy(gh, "pd90506/pi-talaria", wait), {
        repository: "gale/pi-talaria",
        upstream: "pd90506/pi-talaria",
        forked: true,
    });
    assert.equal(calls.filter((each) => each.startsWith("repo fork")).length, 1);

    // The fork is there now: no second one.
    assert.equal((await githubCopy(gh, "pd90506/pi-talaria", wait)).forked, false);
    assert.equal(calls.filter((each) => each.startsWith("repo fork")).length, 1);

    // A repository of that name that is not a fork of pi-talaria is refused.
    const other: Gh = async (args) =>
        args.join(" ") === "api repos/gale/pi-talaria"
            ? JSON.stringify({ full_name: "gale/pi-talaria", fork: false })
            : gh(args);

    await assert.rejects(githubCopy(other, "pd90506/pi-talaria", wait), /is not a fork/);
});
