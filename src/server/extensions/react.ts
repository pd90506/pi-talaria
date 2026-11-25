/**
 * React: Pi puts an emoji reaction on the person's newest message in the session, or takes one off, as a quick sign that
 * it got the message while the work comes first. The reaction shows under that message (`ReactionsDoc`, as `pi`).
 */
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ReactionsDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";

/** Who a reaction is from: Pi itself, not a person. */
export const PI_REACTOR = "pi";
/** The most reactions Pi keeps on one message. */
const MAX_PER_MESSAGE = 3;

const DESCRIPTION =
    "Add an emoji reaction to the person's newest message in this session, or remove one you added (remove: true).";

const GUIDE = `Use the react tool as the smallest sign that you saw the person's message: when work comes before your answer, react (for example 👀 or 👍) and do the work; once your answer is sent, remove that reaction. A question you can answer now gets the answer, not a reaction. Never react instead of an answer the person waits for.`;

/** One emoji or a short shortcode-free symbol: no letters, digits, or spaces, so a reaction cannot carry words. */
function emojiOf(value: string): string {
    const emoji = value.trim();

    if (emoji === "" || [...emoji].length > 8 || /[\p{L}\p{N}\s]/u.test(emoji)) {
        throw new Error(
            "emoji must be the emoji itself, such as 👍 or 👀, not a word or a shortcode.",
        );
    }

    return emoji;
}

export default function createReact(host: PocketHost) {
    const react = defineTool({
        name: "react",
        description: DESCRIPTION,
        parameters: obj(
            {
                emoji: str({
                    minLength: 1,
                    maxLength: 32,
                    description: "The emoji itself, such as 👀",
                }),
                remove: opt(bool({ description: "Take this reaction off instead" })),
            },
            { open: true },
        ),
        // Adding or removing the same reaction again changes nothing.
        replay: "safe",
        execute: async (args, api, context) => {
            const agent = await api.agent(context);

            if (agent.instructions?.startsWith('You are the subagent "')) {
                throw new Error("A subagent has no person to react to.");
            }

            const emoji = emojiOf(args.emoji);
            const remove = args.remove === true;
            const page = await host.messagesOf?.(api.conversationId, { limit: 50 });
            const newest = page?.messages.find((each) => each.kind === "person");

            if (newest === undefined) {
                throw new Error("There is no message from the person here to react to.");
            }

            const key = String(newest.id);
            const text = await api.commit(async (tx) => {
                const doc = await tx.doc(ReactionsDoc, api.conversationId);
                const reactions = { ...(doc.entries[key] ?? {}) };
                const mine = Object.keys(reactions).filter((each) =>
                    reactions[each]!.includes(PI_REACTOR),
                );

                if (remove) {
                    if (!mine.includes(emoji)) {
                        return `No ${emoji} of yours on the person's newest message.`;
                    }

                    const left = reactions[emoji]!.filter((each) => each !== PI_REACTOR);

                    if (left.length === 0) {
                        delete reactions[emoji];
                    } else {
                        reactions[emoji] = left;
                    }
                } else {
                    if (mine.includes(emoji)) {
                        return `${emoji} is already on the person's newest message.`;
                    }

                    if (mine.length >= MAX_PER_MESSAGE) {
                        throw new Error(
                            `A message holds ${MAX_PER_MESSAGE} of your reactions at most: remove one first.`,
                        );
                    }

                    reactions[emoji] = [...(reactions[emoji] ?? []), PI_REACTOR];
                }

                if (Object.keys(reactions).length === 0) {
                    delete doc.entries[key];
                } else {
                    doc.entries[key] = reactions;
                }

                return remove
                    ? `Removed ${emoji} from the person's newest message.`
                    : `Added ${emoji} to the person's newest message.`;
            }, context);

            return { output: [{ type: "text" as const, text }] };
        },
    });

    return defineExtension({
        name: "pocket-react",
        // Reacting changes no file and runs nothing: plan mode lets it run (`plan.ts` lists it).
        tools: [Object.assign(react, { annotations: { readOnlyHint: true } })],
        sections: [section("react", () => GUIDE)],
    });
}
