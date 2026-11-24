// Handoffs from PiP to projects, in the design's fixed scenarios: a transfer after a discussion of several turns, a
// compaction right after a transfer (the coordinator's and PiP's), and one ask of the person's that spans two projects.
import {
    cleanUp,
    lastText,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { SUMMARY_SYSTEM } from "../src/server/pip-compact.ts";

process.env.PI_TALARIA_PIP_DIR = join(root, "pip");
process.env.PI_TALARIA_REPORT_BATCH_MS = "100";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const projects: Record<string, ConversationId> = {};
/** What the model last answered a tool's result with, by the tool's words. */
const results: string[] = [];

before(async () => {
    mkdirSync(work, { recursive: true });
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);
        const system = JSON.stringify(
            (request as { messages: { role: string }[] }).messages.filter(
                (message) => message.role === "system",
            ),
        );

        // A summary, PiP's own or a session's: the conversation's words are in it, and none of its cues apply.
        if (
            system.includes(JSON.stringify(SUMMARY_SYSTEM).slice(1, 60)) ||
            system.includes("context summarization assistant")
        ) {
            return fauxAssistantMessage([fauxText("## Summary\n- A release was discussed.")]);
        }

        const call = (calls: [string, Record<string, unknown>][]) =>
            fauxAssistantMessage(
                calls.map(([name, args]) => fauxToolCall(name, args as never)),
                { stopReason: "toolUse" },
            );

        if (role === "user" && text.includes('<pip-handoff kind="transfer"')) {
            return fauxAssistantMessage([fauxText("Understood: ship on Friday, no beta.")]);
        }

        if (role === "user" && text.includes('<pip-handoff kind="ask"')) {
            const name = /title="([^"]+)"/.exec(text)?.[1] ?? "";

            return fauxAssistantMessage([fauxText(`Answer from ${name}: on track`)]);
        }

        if (role === "user" && text.includes("HAND_THREE")) {
            return call([
                [
                    "projects",
                    {
                        action: "handoff",
                        project: "release",
                        title: "Release plan",
                        summary: "Goal: ship on Friday. Decided: no beta.",
                        messages: 3,
                    },
                ],
            ]);
        }

        if (role === "user" && text.includes("QUOTE_FRIDAY")) {
            return call([
                [
                    "project_thread",
                    {
                        action: "start",
                        title: "Ship",
                        message: "Prepare the Friday release.",
                        quotes: ["no, plan B: ship on Friday"],
                    },
                ],
            ]);
        }

        if (role === "user" && text.includes("READ_PIP")) {
            return call([["project_thread", { action: "pip" }]]);
        }

        if (role === "user" && text.includes("ASK_BOTH")) {
            return call([
                [
                    "projects",
                    { action: "ask", project: "release", title: "Release", summary: "How is it?" },
                ],
                [
                    "projects",
                    { action: "ask", project: "website", title: "Website", summary: "How is it?" },
                ],
            ]);
        }

        if (role === "toolResult") {
            results.push(text);

            return fauxAssistantMessage([fauxText(`ok: ${text.slice(0, 200)}`)]);
        }

        if (role === "user" && text.startsWith("plan A")) {
            return fauxAssistantMessage([fauxText("PIP_REPLY_ONE: plan A has risks.")]);
        }

        return fauxAssistantMessage([fauxText("PIP_REPLY: noted.")]);
    });

    app = await openApp(model);
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    // Compaction keeps only the newest few messages as they are, so a short conversation has something to summarize.
    app.settings.getCompactionSettings = () => ({
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 50,
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    for (const name of ["Release", "Website"]) {
        const response = await fetch(`${base}/api/x/talaria-projects/projects`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({ name, folders: [work] }),
        });
        const made = (await response.json()) as { id: string; coordinator: number };

        projects[made.id] = made.coordinator as unknown as ConversationId;
    }
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const joined = async (id: ConversationId) => (await modelTexts(app, id)).join("\n");

test("a transfer after several turns copies only the person's newest messages it names, in order", async () => {
    const pip = await app.pip.ensure(owner(app));
    const release = projects.release!;

    await say(app, pip, "plan A for the release: ship next month");
    await say(app, pip, "no, plan B: ship on Friday");
    await say(app, pip, "and skip the beta");
    await say(app, pip, "HAND_THREE this to Release");
    await until(async () => (await joined(release)).includes("<pip-handoff"), "the handoff");

    const got = await joined(release);
    const handoff = got.slice(got.indexOf("<pip-handoff"));

    // The person's 3 newest messages, oldest first, each as theirs; not the earlier one, not PiP's answers.
    assert.match(
        handoff,
        /<cited author=\\"user\\"[^>]*>\\nno, plan B: ship on Friday\\n<\/cited>\\n<cited author=\\"user\\"[^>]*>\\nand skip the beta\\n<\/cited>\\n<cited author=\\"user\\"[^>]*>\\nHAND_THREE this to Release/,
    );
    assert.doesNotMatch(handoff, /plan A for the release/);
    assert.doesNotMatch(handoff, /PIP_REPLY/);
    assert.match(handoff, /<pip-summary>\\nGoal: ship on Friday/);
    await until(
        async () => (await joined(release)).includes("Understood: ship on Friday"),
        "the coordinator's answer",
    );
});

test("right after a transfer, a compaction of the coordinator or of PiP keeps the person's words citable", async () => {
    const pip = await app.pip.ensure(owner(app));
    const release = projects.release!;
    const threads = () => app.sessions().filter((each) => each.linkedFrom?.id === Number(release));

    // Pi keeps the newest messages as they are; after two more turns, the handoff is in the summary only.
    await say(app, release, "first more words");
    await say(app, release, "second more words");
    await say(app, pip, "thanks");
    await say(app, pip, "anything else?");
    await app.commands.compact(release, owner(app), undefined);
    await app.commands.compact(pip, owner(app), undefined);
    await until(
        async () => !(await joined(release)).includes("no, plan B: ship on Friday"),
        "the handoff compacted away",
    );
    await until(
        async () => !(await joined(pip)).includes("no, plan B: ship on Friday"),
        "PiP's context compacted too",
    );

    // The coordinator still quotes the person's words from the handoff as theirs: the app checks them in PiP's
    // conversation, which keeps every message.
    await say(app, release, "QUOTE_FRIDAY");
    await until(() => threads().length === 1, "the thread");
    await until(
        async () =>
            (await joined(threads()[0]!.id as unknown as ConversationId)).includes(
                "Prepare the Friday release.",
            ),
        "the thread's brief",
    );
    assert.match(
        await joined(threads()[0]!.id as unknown as ConversationId),
        /<cited author=\\"user\\"[^>]*>\\nno, plan B: ship on Friday/,
    );

    // And it reads back what the person and PiP said before the handoff.
    await say(app, release, "READ_PIP");
    await until(
        async () => (await joined(release)).includes("conversation with PiP"),
        "PiP's conversation",
    );
    const read = await joined(release);

    assert.match(read.slice(read.indexOf("conversation with PiP")), /plan A for the release/);
});

test("one ask of the person's that spans two projects: each coordinator answers, and both answers reach PiP", async () => {
    const pip = await app.pip.ensure(owner(app));

    await say(app, pip, "ASK_BOTH how are the release and the website?");

    for (const id of [projects.release!, projects.website!]) {
        await until(
            async () => (await joined(id)).includes('<pip-handoff kind=\\"ask\\"'),
            "the question",
        );
        assert.match(
            await joined(id),
            /<cited author=\\"user\\"[^>]*>\\nASK_BOTH how are the release and the website\?/,
        );
    }

    await until(async () => {
        const texts = await joined(pip);

        return (
            texts.includes("Answer from Release: on track") &&
            texts.includes("Answer from Website: on track")
        );
    }, "both answers, as reports to PiP");
});
