// The react tool (`extensions/react.ts`): Pi puts an emoji on the person's newest message, and takes it off.
import { cleanUp, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ReactionsDoc } from "../src/server/docs.ts";

/**
 * Each message names its calls: "react 👀" adds one, "unreact 👀" removes one, and "both 👀" adds one and removes it in
 * the same turn, as Pi does when it answers after its work.
 */
const app = await openApp(
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);
        const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
        const person = [...messages].reverse().find((each) => each.role === "user");
        const asked = JSON.stringify(person?.content ?? "");
        const call = /(react|unreact|both) (\S+?)"/.exec(asked);

        if (call === null) {
            return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
        }

        const results = messages
            .slice(messages.indexOf(person!))
            .filter((each) => each.role === "toolResult").length;
        const calls =
            call[1] === "both" ? ["add", "remove"] : [call[1] === "react" ? "add" : "remove"];

        if (role === "toolResult" && results >= calls.length) {
            return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
        }

        return fauxAssistantMessage(
            [
                fauxToolCall("react", {
                    emoji: call[2]!,
                    ...(calls[results] === "remove" ? { remove: true } : {}),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }),
);

after(async () => {
    await app.close();
    cleanUp();
});

const reactions = async (id: number) =>
    (await app.harness.snapshot(ReactionsDoc, id as never, {} as never))?.entries ?? {};
const answered = async (id: number, text: string) =>
    until(
        async () =>
            JSON.stringify(await app.transcripts.allEntries(id as never, true)).includes(
                `ok: ${text}`,
            ),
        `the answer to ${text}`,
    );

test("Pi reacts to the person's newest message, and takes the reaction off again", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "react 👀", requestId: "r-1" });
    await answered(id, "Added 👀");

    const entries = await reactions(id);
    const [entry] = Object.keys(entries);

    assert.deepEqual(Object.values(entries), [{ "👀": ["pi"] }]);

    // The next message gets the next reaction; the first one stays where it was.
    await app.commands.submit(id, owner(app), { text: "unreact 👀", requestId: "r-2" });
    await answered(id, "No 👀 of yours");
    assert.deepEqual(await reactions(id), { [entry!]: { "👀": ["pi"] } });

    await app.commands.submit(id, owner(app), { text: "react 👍", requestId: "r-3" });
    await answered(id, "Added 👍");
    await app.commands.submit(id, owner(app), { text: "unreact 👍", requestId: "r-4" });
    await answered(id, "No 👍 of yours");
    assert.equal(Object.keys(await reactions(id)).length, 2);

    // In one turn: react, work, answer, and take the reaction off.
    await app.commands.submit(id, owner(app), { text: "both 🙏", requestId: "r-5" });
    await answered(id, "Removed 🙏");
    assert.equal(Object.keys(await reactions(id)).length, 2);
    assert.ok(!JSON.stringify(await reactions(id)).includes("🙏"));
});

test("a reaction is an emoji, not a word", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "react ok", requestId: "w-1" });
    await until(
        async () =>
            JSON.stringify(await app.transcripts.allEntries(id as never, true)).includes(
                "not a word",
            ),
        "the refusal",
    );
    assert.deepEqual(await reactions(id), {});
});
