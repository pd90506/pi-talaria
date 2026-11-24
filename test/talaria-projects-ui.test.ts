// Projects' page in a real Chromium, at a phone's size: the rail button opens it, the form makes a project, and the
// app opens the new project's coordinator; back on the page, the project is listed.
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

process.env.PI_TALARIA_PIP_DIR = join(root, "pip");

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const PHONE = { width: 390, height: 844, scale: 1, mobile: true };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const has = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "projects-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(PHONE);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the Projects page makes a project and opens its coordinator", real, async () => {
    await page.navigate(`${base}/`);
    await until(() => has('.rail-ext[title="Projects"]'), "the Projects rail button");
    await inPage(`document.querySelector('.rail-ext[title="Projects"]').click(); return "null"`);
    await until(() => has(".talaria-new input"), "the Projects page");
    assert.equal(await has(".talaria-projects .list-item"), false);

    if (process.env.PI_TALARIA_SHOTS !== undefined) {
        const shot = await page.screenshot({ fullPage: true });

        writeFileSync(join(process.env.PI_TALARIA_SHOTS, "empty.jpg"), shot.data, "base64");
    }

    // Type a name the way a person does, then make it.
    await inPage(`
        const input = document.querySelector(".talaria-new input");
        input.value = "Phone App";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(!document.querySelector(".talaria-new button").disabled)`,
            ),
        "the button to be ready",
    );
    await inPage(`document.querySelector(".talaria-new button").click(); return "null"`);
    await until(
        async () =>
            /\/s\/\d+/.test(await inPage<string>(`return JSON.stringify(location.pathname)`)),
        "the coordinator to open",
    );
    const coordinator = app
        .sessions()
        .find((each) => each.cwd === join(root, "pip", "projects", "phone-app"));

    assert.ok(coordinator, "a coordinator in the project's folder");
    assert.equal(
        await inPage<string>(`return JSON.stringify(location.pathname)`),
        `/s/${coordinator.id}`,
    );

    // Back on the page, from home, the project is listed.
    await page.navigate(`${base}/`);
    await until(() => has('.rail-ext[title="Projects"]'), "the Projects rail button");
    await inPage(`document.querySelector('.rail-ext[title="Projects"]').click(); return "null"`);
    await until(
        async () =>
            (await inPage<string>(
                `return JSON.stringify(document.querySelector(".talaria-projects .talaria-name")?.textContent ?? "")`,
            )) === "Phone App",
        "the project in the list",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.documentElement.scrollWidth <= window.innerWidth)`,
        ),
        true,
        "nothing wider than the phone",
    );

    if (process.env.PI_TALARIA_SHOTS !== undefined) {
        const shot = await page.screenshot({ fullPage: true });

        writeFileSync(join(process.env.PI_TALARIA_SHOTS, "listed.jpg"), shot.data, "base64");
    }
});
