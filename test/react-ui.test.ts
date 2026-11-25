// Pi's reactions (`extensions/react.ts`) in a real browser: each shows under the person's message, and goes when Pi
// takes it off.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { ReactionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "react-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Pi's reaction shows under the person's message, and goes when Pi takes it off",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "hello there");
        const entries = (await app.transcripts.allEntries(id, true)) as {
            id: number;
            kind?: string;
        }[];
        const user = entries.find((each) => JSON.stringify(each).includes("hello there"))!;
        const set = (value: Record<string, string[]> | undefined) =>
            app.harness.commit(async (tx) => {
                const doc = await tx.doc(ReactionsDoc, id);

                if (value === undefined) {
                    delete doc.entries[String(user.id)];
                } else {
                    doc.entries[String(user.id)] = value;
                }
            }, context);

        await page.navigate(`${base}/s/${id}`);
        await until(async () => (await inPage<string>(TEXT)) !== "", "the message", 20_000);
        await set({ "👀": ["pi"] });
        await until(
            async () => (await inPage<string[]>(PILLS)).join() === "👀",
            "the reaction",
            20_000,
        );
        await set(undefined);
        await until(
            async () => (await inPage<string[]>(PILLS)).length === 0,
            "no reaction",
            20_000,
        );
        assert.ok(true);
    },
);

/** The first message's text, once it shows. */
const TEXT = `return JSON.stringify(document.querySelector(".user-text")?.textContent ?? "")`;
/** Pi's reactions under the first message. */
const PILLS = `return JSON.stringify([...document.querySelectorAll(".pi-reaction")].map((each) => each.textContent.trim()))`;
