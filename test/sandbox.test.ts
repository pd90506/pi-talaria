// Sandbox mode (`sandbox.ts`): a dev instance on a copy of the real data reaches nothing outside, and does not carry
// on the real server's work that the copy caught under way.
import {
    cleanUp,
    context,
    home,
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
import { cpSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import { BACKGROUND_MARKER, taskProcesses } from "../src/server/processes.ts";
import { quietCopy, SANDBOX_OFF, sandboxChoice, sandboxLabel } from "../src/server/sandbox.ts";

after(cleanUp);

test("a sandbox label: none, empty, or the given text", () => {
    assert.equal(sandboxLabel(undefined), undefined);
    assert.equal(sandboxLabel(""), undefined);
    assert.equal(sandboxLabel("0"), undefined);
    assert.equal(sandboxLabel("false"), undefined);
    assert.equal(sandboxLabel("1"), "");
    assert.equal(sandboxLabel("TRUE"), "");
    assert.equal(sandboxLabel("  fix login  "), "fix login");
    assert.equal(sandboxLabel("x".repeat(80))?.length, 40);

    const choice = sandboxChoice((file) => (file === "pocket-relay.ts" ? true : undefined));

    for (const file of SANDBOX_OFF) {
        assert.equal(choice(file), false);
    }

    assert.equal(choice("subagents.ts"), undefined);
});

test("a sandbox on a copy stops the run and the queued message it caught, and reaches nothing outside", async () => {
    const real = join(root, "sandbox-real");
    const copy = join(root, "sandbox-copy");
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const model = scriptedModel(async (request, options) => {
        const { text } = lastText(request as never);

        calls.push(text);

        // Until the gate opens, or the app closing stops the request.
        if (text.includes("slow")) {
            await new Promise<void>((resolve, reject) => {
                void gate.then(resolve);
                options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                });
            });
        }

        return fauxAssistantMessage([fauxText("done")]);
    });

    let app = await openApp(model, real);
    const id = await newSession(app);

    app.config.setExtensionEnabled("pocket-relay.ts", true);
    await app.commands.submit(id, owner(app), { text: "slow work", requestId: "sb-1" });
    await until(() => calls.length === 1, "the run to ask the model");
    await app.commands.submit(id, owner(app), { text: "queued after", requestId: "sb-2" });
    await app.close();
    cpSync(real, copy, { recursive: true });

    const dev = await PocketApp.open({
        dataDir: copy,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        home,
        sandbox: "try login",
    });

    try {
        await until(() => !dev.isBusy(id), "the caught run to stop");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(calls, ["slow work"], "the sandbox asked the model nothing");
        assert.equal((await dev.harness.inspect(context)).submissions.length, 0);

        for (const file of SANDBOX_OFF) {
            assert.equal(dev.loader.enabled(file), false, `${file} is off`);
        }

        assert.equal(dev.schedules.running, false);
        assert.equal(dev.pushStore, undefined);

        const hello = await dev.hello(owner(dev));

        assert.equal(hello.server.sandbox, "try login");
        assert.equal(hello.server.supervised, false);
        // Nothing left to stop the second time.
        assert.equal(await quietCopy(dev.harness, context), 0);
    } finally {
        await dev.close();
    }

    // The real data, opened as itself, carries on with both.
    open();
    app = await openApp(model, real);

    try {
        await until(() => calls.includes("queued after"), "the real server to go on");
        assert.equal(app.loader.enabled("pocket-relay.ts"), true);
        assert.notEqual(app.pushStore, undefined);
        assert.equal((await app.hello(owner(app))).server.sandbox, undefined);
    } finally {
        await app.close();
    }
});

test(
    "a sandbox never counts the real server's background process as its own, nor signals it",
    { skip: process.platform === "win32" },
    async () => {
        const realMarker = `${join(root, "sandbox-real")}#1/bg`;
        const devMarker = `${join(root, "sandbox-copy")}#1/bg`;
        const plain = taskProcesses();
        const sandboxed = taskProcesses(process.platform, () => true);
        const { pid } = await plain.spawn(
            "sleep 30",
            work,
            { ...process.env, [BACKGROUND_MARKER]: realMarker },
            {
                pid: 0,
                marker: realMarker,
                files: join(root, "sandbox-files"),
                startedAt: Date.now(),
            },
        );

        try {
            await until(async () => (await plain.startOf(pid)) !== undefined, "the process");

            const startTicks = (await plain.startOf(pid))!;
            // The record the copy holds: the real task's pid and start, under the copy's data folder.
            const copied = {
                pid,
                startTicks,
                ...(plain.boot === undefined ? {} : { boot: plain.boot }),
                marker: devMarker,
                files: join(root, "sandbox-files"),
                startedAt: Date.now(),
            };

            assert.deepEqual(await sandboxed.members(copied, true), []);
            assert.equal(sandboxed.aliveSync(copied), false);
            await sandboxed.signal(copied, "SIGKILL");
            assert.ok((await plain.members({ ...copied, marker: realMarker }, true)).length > 0);

            // Without the sandbox, pid and start alone (Linux) found it: the copy would have stopped the real one.
            if (process.platform === "linux") {
                assert.ok((await plain.members(copied, true)).length > 0);
            }

            // The real marker, sandboxed: still its own task.
            assert.ok(
                (await sandboxed.members({ ...copied, marker: realMarker }, true)).length > 0,
            );
        } finally {
            await plain.killSpawned({ pid, marker: realMarker, files: "", startedAt: 0 }, pid);
            plain.close();
            sandboxed.close();
        }
    },
);
