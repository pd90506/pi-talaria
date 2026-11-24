// Memory files (`talaria-memory.ts`): written whole from the version read, within their sizes; the index the prompt
// carries; and the history index that search_history reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    deleteMemory,
    FILE_BYTES,
    HistoryIndex,
    INDEX_LINES,
    listMemory,
    memoryIndex,
    memoryName,
    memorySummary,
    readMemory,
    writeMemory,
} from "../src/server/talaria-memory.ts";

const root = mkdtempSync(join(tmpdir(), "talaria-memory-"));

after(() => rmSync(root, { recursive: true, force: true }));

test("a memory file is written whole, only from the version read", () => {
    const folder = join(root, "a");
    const first = writeMemory(folder, "decisions.md", "- Use SQLite.", "new");

    assert.equal(readMemory(folder, "decisions.md")?.version, first);
    // Writing it as new again, or from a version nobody read, changes nothing.
    assert.throws(
        () => writeMemory(folder, "decisions.md", "- Use Postgres.", "new"),
        /read it again/,
    );
    assert.throws(
        () => writeMemory(folder, "decisions.md", "- Use Postgres.", "abc"),
        /read it again/,
    );
    assert.throws(() => writeMemory(folder, "other.md", "x", first), /write it with version "new"/);

    const second = writeMemory(folder, "decisions.md", "- Use Postgres.", first);

    assert.equal(readMemory(folder, "decisions.md")?.text, "- Use Postgres.\n");
    assert.throws(() => deleteMemory(folder, "decisions.md", first), /read it again/);
    deleteMemory(folder, "decisions.md", second);
    assert.equal(readMemory(folder, "decisions.md"), undefined);
});

test("names are one .md file, and sizes are kept", () => {
    for (const bad of ["../x.md", "a/b.md", "notes.txt", ".hidden.md", ""]) {
        assert.throws(() => memoryName(bad), /not a memory file/, bad);
    }

    assert.equal(memoryName("memory.md"), "MEMORY.md");

    const folder = join(root, "b");

    assert.throws(
        () => writeMemory(folder, "big.md", "x".repeat(FILE_BYTES + 1), "new"),
        /Split it/,
    );
    writeMemory(folder, "MEMORY.md", "x".repeat(FILE_BYTES + 1), "new");
    assert.deepEqual(
        listMemory(folder).map((each) => each.name),
        ["MEMORY.md"],
    );
});

test("the prompt carries the index's first lines, and its first plain line is the summary", () => {
    const folder = join(root, "c");
    const lines = [
        "# Memory",
        "",
        "Shipping 1.2; waiting on the review.",
        ...Array.from({ length: INDEX_LINES + 50 }, (_, n) => `- [T${n}](t${n}.md): x`),
    ];

    writeMemory(folder, "MEMORY.md", lines.join("\n"), "new");

    const index = memoryIndex(folder)!;

    assert.equal(index.split("\n").length, INDEX_LINES);
    assert.equal(memorySummary(folder), "Shipping 1.2; waiting on the review.");
    assert.equal(memoryIndex(join(root, "none")), undefined);
});

test("history finds words of any length and script, in the conversations asked for only", () => {
    const index = new HistoryIndex(join(root, "history.sqlite"));

    index.add(
        1,
        [
            { entry: 3, kind: "person", at: 10, body: "交接包里要带原话" },
            { entry: 4, kind: "answer", at: 20, body: "The export button is broken on Safari" },
        ],
        4,
    );
    index.add(2, [{ entry: 9, kind: "person", at: 30, body: "Safari again" }], 9);

    assert.equal(index.upto(1), 4);
    assert.equal(index.upto(5), 0);
    assert.deepEqual(
        index.search([1, 2], "safari", 10).map((row) => [row.conversation, row.entry]),
        [
            [2, 9],
            [1, 4],
        ],
    );
    assert.deepEqual(
        index.search([1], "原话", 10).map((row) => row.entry),
        [3],
    );
    assert.deepEqual(
        index.search([1], "交接包 原话", 10).map((row) => row.entry),
        [3],
    );
    assert.deepEqual(index.search([2], "export", 10), []);
    // A quote in the words is only a character.
    assert.deepEqual(index.search([1], 'export"', 10), []);
    index.close();
});
