import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
    installSlot,
    isSlotRoot,
    listSlots,
    makeWritable,
    pointedSlot,
    pruneSlots,
    readLedger,
    setCurrent,
    slotDir,
    slotOf,
} from "../src/server/releases.ts";

const BIN = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));

/** A lock file that asks for `dep` at `version`. */
function lockText(version: string): string {
    return JSON.stringify({ packages: { "": {}, "node_modules/dep": { version } } });
}

/** A git checkout that looks enough like pi-talaria to install: a server, a launcher that says who it is, packages. */
function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "talaria-releases-test-"));
    const repo = join(dir, "repo");
    const data = join(dir, "data");

    t.after(() => {
        makeWritable(join(data, "releases"));
        rmSync(dir, { recursive: true, force: true });
    });

    const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], {
            encoding: "utf8",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@example.com",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@example.com",
            },
        }).trim();

    mkdirSync(join(repo, "src", "server"), { recursive: true });
    mkdirSync(join(repo, "src", "launcher"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(repo, "package-lock.json"), lockText("1.0.0"));
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "export default 1;\n");
    // npm's own record of what it installed, from this lock.
    writeFileSync(
        join(repo, "node_modules", ".package-lock.json"),
        JSON.stringify({ packages: { "node_modules/dep": { version: "1.0.0" } } }),
    );
    writeFileSync(join(repo, "src", "server", "main.ts"), "console.log('server');\n");
    writeFileSync(
        join(repo, "src", "launcher", "main.ts"),
        "console.log('slot launcher ' + new URL('../..', import.meta.url).pathname);\n",
    );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "one");

    /** Commit a change; `lock` changes the lock file too. */
    const commit = (message: string, lock = false) => {
        writeFileSync(
            join(repo, "src", "server", "main.ts"),
            `console.log(${JSON.stringify(message)});\n`,
        );

        if (lock) {
            writeFileSync(join(repo, "package-lock.json"), lockText(message));
        }

        git("commit", "-q", "-am", message);

        return git("rev-parse", "HEAD").slice(0, 12);
    };

    return { dir, repo, data, git, commit };
}

test("a slot holds one commit's files, read-only, with the checkout's packages copied", (t) => {
    const { repo, data, git } = fixture(t);

    writeFileSync(join(repo, "src", "server", "main.ts"), "console.log('not committed');\n");

    const info = installSlot(data, { repo, by: "test", now: 1000 });
    const dir = slotDir(data, info.id);

    assert.equal(info.commit, git("rev-parse", "HEAD"));
    assert.equal(info.id, info.commit.slice(0, 12));
    assert.equal(info.version, "1.0.0");
    assert.equal(info.source, "main");
    // Only what the commit holds: the edit in the checkout is not in the slot.
    assert.equal(
        readFileSync(join(dir, "src", "server", "main.ts"), "utf8"),
        "console.log('server');\n",
    );
    assert.equal(statSync(join(dir, "src", "server", "main.ts")).mode & 0o222, 0);
    assert.equal(statSync(join(dir, "src")).mode & 0o222, 0);
    // The packages: a copy, not links that would share the checkout's files.
    const copied = join(dir, "node_modules", "dep", "index.js");

    assert.ok(existsSync(copied));
    assert.notEqual(
        statSync(copied).ino,
        statSync(join(repo, "node_modules", "dep", "index.js")).ino,
    );
    assert.ok(statSync(copied).mode & 0o200, "packages stay writable");
    assert.deepEqual(
        readLedger(data).map((entry) => [entry.event, entry.slot, entry.by]),
        [["install", info.id, "test"]],
    );
    assert.equal(isSlotRoot(dir), true);
    assert.equal(slotOf(dir), info.id);
    assert.equal(slotOf(repo), undefined);
});

test("slots with the same lock share packages; a new lock installs its own", (t) => {
    const { repo, data, commit } = fixture(t);
    const first = installSlot(data, { repo, by: "test", now: 1 });
    const sameLock = commit("two");
    const installs: string[] = [];
    const second = installSlot(data, {
        repo,
        by: "test",
        now: 2,
        install: (dir) => installs.push(dir),
    });

    assert.equal(second.id, sameLock);
    assert.equal(installs.length, 0);
    assert.equal(
        statSync(join(slotDir(data, first.id), "node_modules", "dep", "index.js")).ino,
        statSync(join(slotDir(data, second.id), "node_modules", "dep", "index.js")).ino,
    );

    // A new lock, and the checkout's packages are still the old ones, as after a pull without npm ci.
    commit("3.0.0", true);
    const third = installSlot(data, {
        repo,
        by: "test",
        now: 3,
        install: (dir) => {
            installs.push(dir);
            mkdirSync(join(dir, "node_modules"));
        },
    });

    assert.equal(installs.length, 1);
    assert.notEqual(third.lock, second.lock);
    // The same commit again is the same slot, installed once.
    assert.equal(installSlot(data, { repo, by: "test" }).installedAt, 3);
    assert.deepEqual(
        listSlots(data).map((slot) => slot.id),
        [third.id, second.id, first.id],
    );
});

test("switching keeps the slot before as previous, and a rollback goes back to it", (t) => {
    const { repo, data, commit } = fixture(t);
    const one = installSlot(data, { repo, by: "test" }).id;

    commit("two");
    const two = installSlot(data, { repo, by: "test" }).id;

    assert.equal(pointedSlot(data, "current"), undefined);
    setCurrent(data, one, "test", "switch", undefined, 10);
    assert.equal(pointedSlot(data, "current"), one);
    assert.equal(pointedSlot(data, "previous"), undefined);
    setCurrent(data, two, "test", "switch", undefined, 20);
    assert.equal(pointedSlot(data, "current"), two);
    assert.equal(pointedSlot(data, "previous"), one);
    setCurrent(data, one, "test", "rollback", "broke", 30);
    assert.equal(pointedSlot(data, "current"), one);
    assert.equal(pointedSlot(data, "previous"), two);
    assert.deepEqual(readLedger(data, 1), [
        { at: 30, event: "rollback", slot: one, from: two, by: "test", note: "broke" },
    ]);
    assert.throws(() => setCurrent(data, "0123456789ab", "test"), /not installed/);
});

test("pruning keeps the newest slots, current, previous, and the running launcher's", (t) => {
    const { repo, data, commit } = fixture(t);
    const ids = [installSlot(data, { repo, by: "test", now: 0 }).id];

    for (let index = 1; index < 7; index++) {
        commit(`c${index}`);
        ids.push(installSlot(data, { repo, by: "test", now: index }).id);
    }

    // Oldest first: ids[0] runs the launcher, ids[1] is previous, ids[2] current.
    setCurrent(data, ids[1]!, "test");
    setCurrent(data, ids[2]!, "test");

    const removed = pruneSlots(data, 4, [ids[0]!], "test");

    // Kept: current, previous, the launcher's, and the newest other one; 4 in all, past the launcher's.
    assert.deepEqual(removed.sort(), [ids[3], ids[4], ids[5]].sort());
    assert.deepEqual(
        listSlots(data)
            .map((slot) => slot.id)
            .sort(),
        [ids[0], ids[1], ids[2], ids[6]].sort(),
    );
    assert.equal(existsSync(slotDir(data, ids[3]!)), false);
});

test("the launcher of the current slot runs, and the commands switch slots", (t) => {
    const { repo, data, commit } = fixture(t);
    const run = (...args: string[]) =>
        spawnSync(process.execPath, [BIN, ...args, "--data", data], {
            encoding: "utf8",
            env: { ...process.env, PI_POCKET_DIR: undefined, PI_TALARIA_NO_SLOT: undefined },
        });

    assert.match(run("versions").stdout, /No releases/);

    const installed = run("release", "install", "--from", repo, "--switch");

    assert.equal(installed.status, 0, installed.stderr);
    const one = pointedSlot(data, "current")!;

    assert.match(installed.stdout, new RegExp(`Release ${one} is current`));
    // Started from this checkout, the launcher that runs is the slot's.
    assert.match(run("--yes").stdout, new RegExp(`slot launcher .*${one}`));

    commit("two");
    assert.equal(run("release", "install", "--from", repo, "--switch").status, 0);
    const two = pointedSlot(data, "current")!;

    assert.notEqual(two, one);
    assert.match(
        run("versions").stdout,
        new RegExp(`\\* current\\s+${two}[\\s\\S]*previous\\s+${one}`),
    );

    const back = run("rollback");

    assert.equal(back.status, 0, back.stderr);
    assert.equal(pointedSlot(data, "current"), one);
    assert.match(run("--yes").stdout, new RegExp(`slot launcher .*${one}`));
    assert.equal(run("rollback", "0123456789ab").status, 1);
});
