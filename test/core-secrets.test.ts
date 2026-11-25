// Core's own secrets (`secrets.ts`): every value core keeps secret is hidden in every session (as `host.hide` hides a
// value), again when the owner saves settings or a file changes, and the old value stays hidden. All values here are
// made up for the test.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HiddenValues } from "../src/server/hidden.ts";

/** A made-up secret, unlike anything else in the test's output. */
const fake = (name: string) => `synthetic-${name}-${randomBytes(9).toString("hex")}`;

const dataDir = join(root, "secrets-data");
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const S = {
    apiKey: fake("module-api-key"),
    defaultToken: fake("module-default-token"),
    newApiKey: fake("module-new-api-key"),
    authKey: fake("auth-api-key"),
    authAccess: fake("auth-oauth-access"),
    authRefresh: fake("auth-oauth-refresh"),
    newAuthKey: fake("auth-new-api-key"),
    previewSecret: fake("preview-secret"),
};
/** Values that are not secret: they must show as they are. */
const PLAIN = {
    region: "plain-region-value-12345",
    authType: "api_key",
    /** A stored value of a module that is off: no spaces, but not a secret. */
    offModel: "claude-sonnet-4-5",
};
/** Everything the model was sent, to check that no secret reached it. */
const sent: string[] = [];
let app: App;
/** A file in the session's folder, not one of core's, that holds every value: what a careless command would print. */
const dump = join(work, "dump.txt");

const route: FauxResponseStep = (request) => {
    sent.push(JSON.stringify(request));

    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    const [verb = "", ...rest] = text.split(" ");

    if (verb === "run") {
        return call("bash", { command: rest.join(" ") });
    }

    if (verb === "read") {
        return call("read", { path: rest.join(" ") });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

function writeAuth(key: string): void {
    writeFileSync(
        join(agentDir, "auth.json"),
        JSON.stringify({
            "example-api": { type: PLAIN.authType, key },
            "example-oauth": {
                type: "oauth",
                access: S.authAccess,
                refresh: S.authRefresh,
                expires: 4102444800000,
            },
        }),
        { mode: 0o600 },
    );
}

function writeDump(...values: string[]): void {
    writeFileSync(dump, `${values.join("\n")}\n`);
}

const stored = async (id: ConversationId) =>
    JSON.stringify(await app.transcripts.allEntries(id, true));

async function say(id: ConversationId, text: string): Promise<string> {
    const before = (await app.transcripts.allEntries(id, true)).length;

    await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
    await until(
        async () =>
            (await app.transcripts.allEntries(id, true))
                .slice(before)
                .some(
                    (entry) =>
                        entry.kind === "assistant" &&
                        entry.blocks.some(
                            (block) => block.type === "text" && /^(ok|echo): /.test(block.text),
                        ),
                ),
        `the answer to ${text}`,
    );

    return JSON.stringify((await app.transcripts.allEntries(id, true)).slice(before));
}

function assertHidden(text: string, ...values: string[]): void {
    for (const value of values) {
        assert.ok(!text.includes(value), "a secret value was shown");
    }
}

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    mkdirSync(join(dataDir, "x.vault"), { recursive: true });
    writeFileSync(join(dataDir, "x.vault", "state.json"), "{}\n");
    writeFileSync(
        join(dataDir, "extensions", "vault.ts"),
        `/** Vault: a module with a secret setting, for tests. */
export default (_host, web) => {
    web.settings([
        { name: "apiKey", label: "API key", type: "text", secret: true },
        { name: "token", label: "Token", type: "text", secret: true, default: ${JSON.stringify(S.defaultToken)} },
        { name: "region", label: "Region", type: "text" },
    ]);
};
`,
    );
    writeAuth(S.authKey);
    app = await openApp(scriptedModel(route), dataDir);
    await app.setExtensionEnabled(owner(app), "vault.ts", true);
    app.setExtensionSettings(owner(app), "vault", {
        apiKey: S.apiKey,
        region: PLAIN.region,
    });
    // A module that is off keeps its values in config.json: which are secret is unknown, so none is hidden.
    app.config.setExtensionSettings("dormant", { model: PLAIN.offModel });
    // A part of core with a secret in a file of its own (as Pi Pocket Teams' previews have): it adds the file.
    writeFileSync(join(dataDir, "preview-secret"), S.previewSecret, { mode: 0o600 });
    app.secrets.watchFile({
        path: join(dataDir, "preview-secret"),
        read: (text) => [{ value: text.trim(), label: "preview secret" }],
    });
    app.secrets.sync();
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("each source of core's secrets is hidden by name: settings, owner token, push key, Pi's sign-ins, a file", () => {
    const labels = app.secrets.labels();

    for (const name of [
        "owner token",
        "secret vault.apiKey",
        "secret vault.token",
        "push private key",
        "auth example-api",
        "auth example-oauth",
        "preview secret",
    ]) {
        assert.ok(labels.includes(name), `${name} is hidden`);
    }

    // Labels only: no value is ever listed.
    assertHidden(JSON.stringify(labels), ...Object.values(S), app.config.ownerToken);
});

test("a command's output hides every secret, in the transcript and in what the model reads", async () => {
    const push = JSON.parse(readFileSync(join(dataDir, "push.json"), "utf8")) as {
        vapid: { publicKey: string; privateKey: string };
    };
    const secrets = [
        app.config.ownerToken,
        S.apiKey,
        S.defaultToken,
        push.vapid.privateKey,
        S.authKey,
        S.authAccess,
        S.authRefresh,
        S.previewSecret,
    ];

    writeDump(...secrets, PLAIN.region, PLAIN.offModel, push.vapid.publicKey);

    const id = await newSession(app);
    const before = sent.length;
    const turn = await say(id, `run cat ${dump}`);

    for (const name of [
        "owner token",
        "secret vault.apiKey",
        "secret vault.token",
        "push private key",
        "auth example-api",
        "auth example-oauth",
        "preview secret",
    ]) {
        assert.ok(turn.includes(`[${name}]`), `${name} shows as its label`);
    }

    assertHidden(await stored(id), ...secrets);
    assertHidden(sent.slice(before).join("\n"), ...secrets);
    // What is not secret shows as it is.
    assert.ok(turn.includes(PLAIN.region), "a setting that is not secret shows");
    assert.ok(turn.includes(PLAIN.offModel), "a value of a module that is off shows");
    assert.ok(turn.includes(push.vapid.publicKey), "the push public key shows");
});

test("the reported command: config.json's secrets are hidden in what it prints", async () => {
    const id = await newSession(app);
    const turn = await say(id, `run jq . ${join(dataDir, "config.json")}`);

    // The command ran: config.json's other fields show, its secrets do not.
    assert.match(turn, /extensionSettings/);
    assert.match(turn, /\[secret vault\.apiKey\]/);
    assert.match(turn, /\[owner token\]/);
    assert.ok(turn.includes(PLAIN.region));
    assertHidden(await stored(id), app.config.ownerToken, S.apiKey);
});

test("saving settings hides the new value at once, in sessions already open and in new ones, and the old one stays hidden", async () => {
    const open = await newSession(app);

    await say(open, "hello");
    app.setExtensionSettings(owner(app), "vault", { apiKey: S.newApiKey });

    // Hidden at once, before any tool runs, in every session: people's messages hide it too.
    assert.equal(app.hidden.replace(S.newApiKey, open), "[secret vault.apiKey]");
    assert.equal(app.hidden.replace(S.apiKey, open), "[secret vault.apiKey]");

    const fresh = await newSession(app);

    writeDump(S.apiKey, S.newApiKey);

    for (const id of [open, fresh]) {
        await say(id, `run cat ${dump}`);
        assertHidden(await stored(id), S.apiKey, S.newApiKey);
    }

    // A message that pastes the new value keeps it out too.
    await say(fresh, `the key is ${S.newApiKey}`);
    assertHidden(await stored(fresh), S.newApiKey);
});

test("a sign-in that changes in auth.json is hidden from the next command, and the old key stays hidden", async () => {
    writeAuth(S.newAuthKey);
    writeDump(S.authKey, S.newAuthKey);

    const id = await newSession(app);

    await say(id, `run cat ${dump}`);
    assertHidden(await stored(id), S.authKey, S.newAuthKey);
});

test("PiP's tool results hide core's secrets too", async () => {
    const pip = await app.pip.ensure(owner(app));

    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    writeDump(S.apiKey, S.newApiKey, app.config.ownerToken, S.previewSecret);
    await say(pip, `read ${dump}`);

    const transcript = await stored(pip);

    assert.match(transcript, /\[secret vault\.apiKey\]/);
    assertHidden(transcript, S.apiKey, S.newApiKey, app.config.ownerToken, S.previewSecret);
});

test("a value that is too short to hide safely is not hidden, and the list never takes the values", () => {
    app.config.setExtensionSettings("vault", { apiKey: "short" });
    app.secrets.sync();

    assert.equal(app.hidden.replace("short words", 1), "short words");
    // The earlier value stays hidden.
    assert.equal(app.hidden.replace(S.newApiKey, 1), "[secret vault.apiKey]");
});

test("output that starts no secret streams at once; only a possible start of one waits for the next chunk", () => {
    const hidden = new HiddenValues();
    const secret = fake("streamed");

    hidden.add({ value: secret, label: "secret S" });

    const out: string[] = [];
    const stream = hidden.stream(1, (text) => out.push(text));
    const info = { stream: "stdout" } as const;

    // An owner token is always hidden, so every command's output goes through this: a short line must not wait.
    stream.onOutput("tick 1\n", context, info);
    assert.deepEqual(out, ["tick 1\n"]);

    // The start of the value waits, and the rest of it hides it whole.
    stream.onOutput(`next ${secret.slice(0, 12)}`, context, info);
    assert.equal(out.join(""), "tick 1\nnext ");
    stream.onOutput(`${secret.slice(12)} done\n`, context, info);
    stream.flush();
    assert.equal(out.join(""), "tick 1\nnext [secret S] done\n");
});
