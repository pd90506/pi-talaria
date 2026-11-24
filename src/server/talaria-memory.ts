/**
 * Memory files at pip's two levels, the person's (`~/pip/home/memory`) and each project's (`~/pip/projects/<p>/memory`):
 * a `MEMORY.md` index, which the prompt carries, and topic files, read when needed. Agents write each file whole, from
 * the version they read, so that two never overwrite each other unseen. And a full-text index of what was said in past
 * sessions, for `search_history` (`talaria-projects.ts`).
 */
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The index of a level's memory: one line for each topic file. */
export const INDEX_FILE = "MEMORY.md";
/** How much of the index the prompt carries: the first 200 lines or 25 KB, whichever comes first. */
export const INDEX_LINES = 200;
export const INDEX_BYTES = 25_000;
/** A topic file's size at most: past it, split it or summarize it. */
export const FILE_BYTES = 4_096;
/** Files in one level's memory, at most. */
export const MAX_FILES = 100;
/** What a write gives as its version for a file that is not there yet. */
export const NEW_FILE = "new";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.md$/;

/** A file's name in a memory folder, checked: one `.md` file, no folders. */
export function memoryName(name: string | undefined): string {
    const given = (name ?? "").trim();

    if (!NAME.test(given) || given.includes("..")) {
        throw new Error(
            `${JSON.stringify(given)} is not a memory file: a name like decisions.md (letters, digits, . _ -, ending in .md), with no folders.`,
        );
    }

    return given.toLowerCase() === INDEX_FILE.toLowerCase() ? INDEX_FILE : given;
}

/** A file's version: what a write must give to replace it. */
export const versionOf = (text: string): string =>
    createHash("sha256").update(text).digest("hex").slice(0, 12);

export type MemoryFile = { name: string; bytes: number; at: number };

/** The files in a memory folder, the index first, then by name. */
export function listMemory(folder: string): MemoryFile[] {
    let names: string[];

    try {
        names = readdirSync(folder);
    } catch {
        return [];
    }

    return names
        .filter((name) => NAME.test(name))
        .flatMap((name) => {
            try {
                const stat = statSync(join(folder, name));

                return stat.isFile() ? [{ name, bytes: stat.size, at: stat.mtimeMs }] : [];
            } catch {
                return [];
            }
        })
        .sort((a, b) =>
            a.name === INDEX_FILE ? -1 : b.name === INDEX_FILE ? 1 : a.name.localeCompare(b.name),
        );
}

/** A memory file's text and version; undefined when it is not there. */
export function readMemory(
    folder: string,
    name: string,
): { text: string; version: string } | undefined {
    const path = join(folder, memoryName(name));

    if (!existsSync(path)) {
        return undefined;
    }

    const text = readFileSync(path, "utf8");

    return { text, version: versionOf(text) };
}

/** Why a file cannot be changed from `version`; undefined when it can. */
function stale(folder: string, name: string, version: string | undefined): string | undefined {
    const now = readMemory(folder, name);

    if (now === undefined) {
        return version === NEW_FILE
            ? undefined
            : `${name} is not there: write it with version "new".`;
    }

    return version === now.version
        ? undefined
        : `${name} changed since you read it, or you did not read it: read it again, then write it whole from what it says now.`;
}

/** Write a memory file whole, replacing the version given (`new` for a new file). Returns its new version. */
export function writeMemory(
    folder: string,
    name: string,
    text: string,
    version: string | undefined,
): string {
    const file = memoryName(name);
    const body = `${text.replace(/\r\n?/g, "\n").trimEnd()}\n`;
    const limit = file === INDEX_FILE ? INDEX_BYTES : FILE_BYTES;

    if (body.trim() === "") {
        throw new Error("A memory file needs text; delete it instead.");
    }

    if (Buffer.byteLength(body) > limit) {
        throw new Error(
            `${file} would be ${String(Buffer.byteLength(body))} bytes; ${String(limit)} at most. ${file === INDEX_FILE ? "Keep one short line for each file." : "Split it by subject, or summarize it."}`,
        );
    }

    const refused = stale(folder, file, version);

    if (refused !== undefined) {
        throw new Error(refused);
    }

    if (version === NEW_FILE && listMemory(folder).length >= MAX_FILES) {
        throw new Error(`A memory holds ${String(MAX_FILES)} files at most: merge some first.`);
    }

    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Whole or not at all: a reader never sees half a file.
    const part = join(folder, `.${file}.${process.pid}.part`);

    writeFileSync(part, body, { mode: 0o600 });
    renameSync(part, join(folder, file));
    indexes.delete(folder);

    return versionOf(body);
}

/** Delete a memory file, from the version read. */
export function deleteMemory(folder: string, name: string, version: string | undefined): void {
    const file = memoryName(name);

    if (readMemory(folder, file) === undefined) {
        return;
    }

    const refused = stale(folder, file, version);

    if (refused !== undefined) {
        throw new Error(refused);
    }

    rmSync(join(folder, file), { force: true });
    indexes.delete(folder);
}

/** The last read of each index, by folder and modification time: the prompt asks on each request. */
const indexes = new Map<string, { at: number; text: string | undefined }>();

/** What the prompt carries of a level's index: its first {@link INDEX_LINES} lines or {@link INDEX_BYTES}. */
export function memoryIndex(folder: string): string | undefined {
    const path = join(folder, INDEX_FILE);
    let at: number;

    try {
        at = statSync(path).mtimeMs;
    } catch {
        return undefined;
    }

    const kept = indexes.get(folder);

    if (kept?.at === at) {
        return kept.text;
    }

    let text: string | undefined;

    try {
        const lines = readFileSync(path, "utf8").split("\n").slice(0, INDEX_LINES);
        const kept: string[] = [];
        let bytes = 0;

        for (const line of lines) {
            bytes += Buffer.byteLength(line) + 1;

            if (bytes > INDEX_BYTES) {
                break;
            }

            kept.push(line);
        }

        text = kept.join("\n").trim() || undefined;
    } catch {
        text = undefined;
    }

    indexes.set(folder, { at, text });

    return text;
}

/** A level's one-line summary: the first line of its index that is not a heading, cut at 160 characters. */
export function memorySummary(folder: string): string | undefined {
    const line = memoryIndex(folder)
        ?.split("\n")
        .map((each) => each.trim())
        .find((each) => each !== "" && !each.startsWith("#"));

    return line === undefined ? undefined : [...line].slice(0, 160).join("");
}

/** One message in the history index. */
export type HistoryRow = {
    conversation: number;
    entry: number;
    kind: string;
    at: number;
    body: string;
};

/** What one message may put in the index. */
const BODY_CHARS = 20_000;

/**
 * Past messages, full-text searchable (SQLite FTS5, trigram: any script, words of 3 characters or more; shorter ones are
 * matched as they are). Each conversation is indexed up to an entry, and caught up when searched.
 */
export class HistoryIndex {
    readonly #path: string;
    #db: DatabaseSync | undefined;

    constructor(path: string) {
        this.#path = path;
    }

    #open(): DatabaseSync {
        if (this.#db === undefined) {
            const db = new DatabaseSync(this.#path);

            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
                    body, conversation UNINDEXED, entry UNINDEXED, kind UNINDEXED, at UNINDEXED,
                    tokenize = 'trigram'
                );
                CREATE TABLE IF NOT EXISTS indexed (conversation INTEGER PRIMARY KEY, upto INTEGER NOT NULL);
            `);
            this.#db = db;
        }

        return this.#db;
    }

    /** The newest entry of `conversation` the index has; 0 for none. */
    upto(conversation: number): number {
        const row = this.#open()
            .prepare("SELECT upto FROM indexed WHERE conversation = ?")
            .get(conversation) as { upto: number } | undefined;

        return row?.upto ?? 0;
    }

    /** Add a conversation's messages newer than its mark, and move the mark to `upto`. */
    add(
        conversation: number,
        rows: readonly Omit<HistoryRow, "conversation">[],
        upto: number,
    ): void {
        const db = this.#open();
        const insert = db.prepare(
            "INSERT INTO messages (body, conversation, entry, kind, at) VALUES (?, ?, ?, ?, ?)",
        );

        db.exec("BEGIN");

        try {
            for (const row of rows) {
                insert.run(
                    row.body.slice(0, BODY_CHARS),
                    conversation,
                    row.entry,
                    row.kind,
                    row.at,
                );
            }

            db.prepare(
                "INSERT INTO indexed (conversation, upto) VALUES (?, ?) ON CONFLICT (conversation) DO UPDATE SET upto = excluded.upto",
            ).run(conversation, upto);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");

            throw error;
        }
    }

    /** Messages of `conversations` with every word of `query`, newest first. */
    search(conversations: readonly number[], query: string, limit: number): HistoryRow[] {
        const words = query.split(/\s+/).filter(Boolean).slice(0, 8);

        if (words.length === 0 || conversations.length === 0) {
            return [];
        }

        const long = words.filter((word) => [...word].length >= 3);
        const short = words.filter((word) => [...word].length < 3);
        const where = [
            `CAST(conversation AS INTEGER) IN (${conversations.map(() => "?").join(", ")})`,
            ...(long.length === 0 ? [] : ["messages MATCH ?"]),
            ...short.map(() => "body LIKE ? ESCAPE '\\'"),
        ];
        const values = [
            ...conversations,
            ...(long.length === 0
                ? []
                : [long.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ")]),
            ...short.map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`),
        ];

        return this.#open()
            .prepare(
                `SELECT body, conversation, entry, kind, at FROM messages WHERE ${where.join(" AND ")} ORDER BY CAST(at AS INTEGER) DESC LIMIT ?`,
            )
            .all(...values, Math.max(1, Math.min(limit, 50)))
            .map((row) => {
                const each = row as Record<string, unknown>;

                return {
                    body: String(each.body),
                    conversation: Number(each.conversation),
                    entry: Number(each.entry),
                    kind: String(each.kind),
                    at: Number(each.at),
                };
            });
    }

    close(): void {
        this.#db?.close();
        this.#db = undefined;
    }
}
