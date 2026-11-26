// Dev instances (`dev-instances.ts`): pi-talaria from a checkout, in sandbox mode, on a copy of the real data, beside
// the real server.
import {
    cleanUp,
    lastText,
    loadTools,
    modelTexts,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";
import { DevInstances } from "../src/server/dev-instances.ts";

after(cleanUp);

/** The app's page over a Unix socket: its status and body. */
function get(socket: string, path = "/"): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const asked = request({ socketPath: socket, path }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });

        asked.on("error", reject);
        asked.end();
    });
}

const alive = (pid: number | undefined) => {
    try {
        process.kill(pid!, 0);

        return true;
    } catch {
        return false;
    }
};

test("a dev instance runs a checkout on a copy of the data, in sandbox mode, and stops", async () => {
    const data = join(root, "dev-real");
    const app = await openApp(scriptedModel(), data);

    await app.close();
    // What the copy leaves out, and what it keeps.
    mkdirSync(join(data, "releases"), { recursive: true });
    writeFileSync(join(data, "releases", "current.json"), "{}");
    mkdirSync(join(data, "worktrees", "x"), { recursive: true });
    mkdirSync(join(data, "agent"), { recursive: true });
    writeFileSync(join(data, "agent", "auth.json"), "{}");
    mkdirSync(join(data, "uploads"), { recursive: true });
    writeFileSync(join(data, "uploads", "kept.txt"), "kept");

    const exposed: number[] = [];
    const unexposed: number[] = [];
    const options = {
        data,
        agentDir: join(data, "agent"),
        ports: [20443],
        prepare: async () => {},
        expose: async (port: number) => {
            exposed.push(port);

            return `https://machine.example:${port}/`;
        },
        unexpose: async (port: number) => {
            unexposed.push(port);
        },
    };
    const dev = new DevInstances(options);
    let second: DevInstances | undefined;

    try {
        const started = await dev.start(APP_ROOT, { label: "try it" });

        assert.equal(started.status, "running", String(started.error));
        assert.equal(started.url, "https://machine.example:20443/");
        assert.deepEqual(exposed, [20443]);
        assert.ok(alive(started.pid));
        assert.equal((await get(started.socket)).status, 200);

        // The copy: the database and the data, without the real server's releases, worktrees, or Pi's folder.
        assert.ok(existsSync(join(started.data, "pocket.sqlite")));
        assert.equal(readFileSync(join(started.data, "uploads", "kept.txt"), "utf8"), "kept");
        assert.equal(existsSync(join(started.data, "releases")), false);
        assert.equal(existsSync(join(started.data, "worktrees")), false);
        assert.equal(existsSync(join(started.data, "agent")), false);
        assert.match(dev.logs(started.id), /start .* from /);
        // In sandbox mode, with its label.
        assert.match(
            dev.logs(started.id),
            /Sandbox: push notifications, schedules, triggers, and Relay are off/,
        );

        // One port, taken: another checkout waits for a stop.
        const other = join(root, "dev-other");

        mkdirSync(join(other, "src", "server"), { recursive: true });
        writeFileSync(join(other, "src", "server", "main.ts"), "");
        await assert.rejects(dev.start(other), /dev instances run already/);
        await assert.rejects(dev.start(data), /not a pi-talaria checkout/);

        // A restart keeps what was tried on the copy; a fresh one copies the real data again.
        writeFileSync(join(started.data, "tried.txt"), "yes");

        const again = await dev.restart(started.id);

        assert.equal(again.status, "running", String(again.error));
        assert.notEqual(again.pid, started.pid);
        assert.equal(alive(started.pid), false);
        assert.ok(existsSync(join(started.data, "tried.txt")));

        const fresh = await dev.restart(started.id, true);

        assert.equal(fresh.status, "running", String(fresh.error));
        assert.equal(existsSync(join(started.data, "tried.txt")), false);

        // The real server stopped without stopping it: the next one stops what is left.
        second = new DevInstances(options);
        await until(() => !alive(fresh.pid), "the leftover instance to stop");
        assert.equal(second.get(started.id)?.status, "stopped");
        assert.ok(unexposed.includes(20443));
    } finally {
        await dev.close();
        await second?.close();
    }
});

test("a dev instance that cannot start says why, and stop ends one that runs", async () => {
    const data = join(root, "dev-broken");
    const checkout = join(root, "dev-broken-checkout");

    mkdirSync(join(checkout, "src", "server"), { recursive: true });
    writeFileSync(
        join(checkout, "src", "server", "main.ts"),
        'console.error("cannot start here"); process.exit(3);\n',
    );
    mkdirSync(data, { recursive: true });

    const dev = new DevInstances({
        data,
        ports: [20444],
        prepare: async () => {},
        expose: async () => undefined,
        unexpose: async () => {},
    });

    try {
        const failed = await dev.start(checkout);

        assert.equal(failed.status, "failed");
        assert.match(failed.error ?? "", /cannot start here/);

        const real = await dev.start(APP_ROOT, { label: "ok" });

        assert.equal(real.status, "running", String(real.error));
        assert.equal(real.url, undefined);

        const stopped = await dev.stop(real.id);

        assert.equal(stopped.status, "stopped");
        assert.equal(alive(real.pid), false);
        assert.equal(dev.list().find((each) => each.id === real.id)?.status, "stopped");
    } finally {
        await dev.close();
    }
});

test("the real server runs dev instances; a dev instance does not", async () => {
    const app = await openApp(scriptedModel(), join(root, "dev-app"));

    try {
        assert.ok(app.devInstances !== undefined);
        assert.equal(app.loader.enabled("dev-instances.ts"), true);
        assert.equal(
            app.loader.list().find((each) => each.file === "dev-instances.ts")?.error,
            undefined,
        );
    } finally {
        await app.close();
    }
});

test("Pi's dev_instance tool tells what runs", async () => {
    const model = scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
        }

        return fauxAssistantMessage([fauxToolCall("dev_instance", { action: "status" })], {
            stopReason: "toolUse",
        });
    });
    const app = await openApp(model, join(root, "dev-tool"));

    try {
        const id = await newSession(app);

        await loadTools(app, id, "dev_instance");
        await say(app, id, "what dev instances run?");
        assert.ok((await modelTexts(app, id)).some((text) => text.includes("No dev instances.")));
    } finally {
        await app.close();
    }
});
