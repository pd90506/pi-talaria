/**
 * A session's conversation as messages, without tool calls: what people typed, what reached it from elsewhere (another
 * session, an inbox, a schedule: `[via …]`), and Pi's answers. For a lead reading a session it started, and for words
 * a module checks were a person's own.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AuthorsDoc } from "./docs.ts";
import { projectEntry } from "./projection.ts";

const context = BACKGROUND_CONTEXT;
/** Entries one page may look through to fill it. */
const SCAN_LIMIT = 400;
const VIA_PREFIX = /^\[via ([^\]\n]*)\]\s?/;

export type SessionMessage = {
    /** The entry's id: a page's `before` continues below the oldest one. */
    id: number;
    /**
     * `person`: typed by a person, as the conversation's authors document says. `via`: sent for them from elsewhere,
     * or put there by the app (a report, a schedule). `answer`: Pi's text, a turn's last part.
     */
    kind: "person" | "via" | "answer";
    text: string;
    /** For `person`, who typed it, when the session is shared; for `via`, what sent it. */
    from?: string;
    at?: number;
};

/**
 * Up to `limit` messages of conversation `id`, newest first, older than entry `before` when given. `before` in the
 * result continues the scan; absent when nothing older is left.
 */
export async function sessionMessages(
    app: PocketApp,
    id: ConversationId,
    request: { limit?: number; before?: number } = {},
): Promise<{ messages: SessionMessage[]; before?: number }> {
    const limit = Math.max(1, Math.min(Math.round(request.limit ?? 10), 50));
    const conversation = await app.conversation(id);
    const page = await conversation.entries(
        request.before === undefined
            ? {}
            : { maxEntryId: (request.before - 1) as unknown as EntryId },
        SCAN_LIMIT,
        undefined,
        context,
    );
    // Only a message a person wrote is theirs: a report or a module's input has no `[via …]` label of its own.
    const authors = (await app.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {};
    const messages: SessionMessage[] = [];
    let oldest: number | undefined;

    for (const entry of page.items) {
        if (messages.length >= limit) {
            break;
        }

        const shown = projectEntry(entry, true);

        oldest = Number(entry.id);

        if (shown?.kind === "user") {
            const via = VIA_PREFIX.exec(shown.text);
            const wrote = via === null && authors[String(shown.id)] !== undefined;

            messages.push({
                id: shown.id,
                kind: wrote ? "person" : "via",
                text: via === null ? shown.text : shown.text.slice(via[0].length),
                ...(wrote
                    ? shown.from === undefined
                        ? {}
                        : { from: shown.from }
                    : { from: via === null ? "the app" : via[1]! }),
                ...(shown.at === undefined ? {} : { at: shown.at }),
            });
        } else if (shown?.kind === "assistant" && shown.stopReason !== "toolUse") {
            const text = shown.blocks
                .flatMap((block) =>
                    block.type === "text" && block.text.trim() !== "" ? [block.text] : [],
                )
                .join("\n")
                .trim();

            if (text !== "") {
                messages.push({
                    id: shown.id,
                    kind: "answer",
                    text,
                    ...(shown.at === undefined ? {} : { at: shown.at }),
                });
            }
        }
    }

    const more = messages.length >= limit || page.next !== undefined;

    return {
        messages,
        ...(more && oldest !== undefined && oldest > 1 ? { before: oldest } : {}),
    };
}
