/**
 * Activity lines in a conversation's stored chat ("saved a lesson…"). The side chat that showed them is gone; the
 * lesson memory still writes them until it goes too.
 */
import { randomUUID } from "node:crypto";
import type { User } from "./config.ts";
import { CHAT_LIMIT, type ChatMessage } from "./docs.ts";

/** The same activity line from the same person within this time is one line, not many. */
const ACTIVITY_MERGE_MS = 10 * 60_000;

/**
 * Add an activity line to a chat, within a commit: `who` did `text`. The same line from the same person again soon is
 * one line, not many.
 */
export function addActivity(
    chat: { messages: ChatMessage[] },
    who: Pick<User, "id" | "name">,
    text: string,
    now = Date.now(),
): void {
    const last = chat.messages.at(-1);

    if (
        last?.kind === "event" &&
        last.userId === who.id &&
        last.text === text &&
        now - last.at < ACTIVITY_MERGE_MS
    ) {
        last.at = now;

        return;
    }

    chat.messages.push({
        id: `ev-${randomUUID()}`,
        userId: who.id,
        name: who.name,
        text,
        at: now,
        kind: "event",
    });

    if (chat.messages.length > CHAT_LIMIT) {
        chat.messages.splice(0, chat.messages.length - CHAT_LIMIT);
    }
}
