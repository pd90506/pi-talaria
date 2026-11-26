import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
    databasePath,
    declarationOf,
    failTrial,
    installSlot,
    isSlotRoot,
    listSlots,
    listSnapshots,
    makeWritable,
    noteDataVersion,
    pointedSlot,
    preflight,
    pruneSlots,
    pruneSnapshots,
    readDataVersion,
    readLedger,
    readTrial,
    schemaHash,
    setCurrent,
    slotDir,
    slotOf,
    snapshotDatabase,
    writeSource,
    writeTrial,
} from "../src/server/releases.ts";
import { ReleaseManager } from "../src/server/release-manager.ts";

const BIN = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../src/launcher/main.ts", import.meta.url));

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

// ─── Trials ─────────────────────────────────────────────────────────────

/** A slot made by hand: a stand-in server (`server`, its code) and the record beside it. */
function handSlot(data: string, id: string, server: string): void {
    const dir = slotDir(data, id);

    mkdirSync(join(dir, "src", "server"), { recursive: true });
    writeFileSync(join(dir, "src", "server", "main.ts"), server);
    writeFileSync(
        join(data, "releases", "slots", `${id}.json`),
        JSON.stringify({
            v: 1,
            id,
            commit: id.padEnd(40, "0"),
            version: "1.0.0",
            source: "test",
            installedAt: 0,
            lock: "",
        }),
    );
}

/** A database with one table, or two once migrated. */
function makeDatabase(data: string, migrated = false): void {
    const database = new DatabaseSync(databasePath(data));

    database.exec("CREATE TABLE IF NOT EXISTS t (x)");
    database.exec("INSERT INTO t VALUES (1)");

    if (migrated) {
        database.exec("CREATE TABLE IF NOT EXISTS added (y)");
    }

    database.close();
}

function rows(data: string): number {
    const database = new DatabaseSync(databasePath(data), { readOnly: true });
    const { n } = database.prepare("SELECT count(*) AS n FROM t").get() as { n: number };

    database.close();

    return n;
}

test("a failed trial goes back, and restores the database only when its schema changed", (t) => {
    const { data } = fixture(t);

    mkdirSync(data, { recursive: true });
    handSlot(data, "aaaaaaaaaaaa", "");
    handSlot(data, "bbbbbbbbbbbb", "");
    setCurrent(data, "aaaaaaaaaaaa", "test");
    makeDatabase(data);

    // Same schema: the code goes back, the data written on trial stays.
    let snapshot = snapshotDatabase(data, "before-b", "test", 1);

    writeTrial(data, {
        v: 1,
        slot: "bbbbbbbbbbbb",
        from: "aaaaaaaaaaaa",
        at: 1,
        crashes: 0,
        snapshot,
        schema: schemaHash(snapshot),
    });
    setCurrent(data, "bbbbbbbbbbbb", "test");
    makeDatabase(data);
    assert.match(failTrial(data, "it did not start", "test")!, /back on release aaaaaaaaaaaa\.$/);
    assert.equal(pointedSlot(data, "current"), "aaaaaaaaaaaa");
    assert.equal(rows(data), 2);
    assert.equal(readTrial(data), undefined);

    // A migration on trial: the database goes back to the copy, and the migrated one is kept as a copy too.
    snapshot = snapshotDatabase(data, "before-b", "test", 2);
    writeTrial(data, {
        v: 1,
        slot: "bbbbbbbbbbbb",
        from: "aaaaaaaaaaaa",
        at: 2,
        crashes: 0,
        snapshot,
        schema: schemaHash(snapshot),
    });
    setCurrent(data, "bbbbbbbbbbbb", "test");
    makeDatabase(data, true);
    assert.match(failTrial(data, "it crashed", "test")!, /database went back/);
    assert.equal(rows(data), 2);
    assert.equal(pointedSlot(data, "current"), "aaaaaaaaaaaa");
    assert.ok(listSnapshots(data).some((file) => file.includes("before-restore-bbbbbbbbbbbb")));
    assert.deepEqual(
        readLedger(data, 1).map((entry) => [entry.event, entry.slot, entry.from]),
        [["rollback", "aaaaaaaaaaaa", "bbbbbbbbbbbb"]],
    );
    assert.equal(failTrial(data, "again", "test"), undefined);

    pruneSnapshots(data, 1);
    assert.equal(listSnapshots(data).length, 1);
});

test("a slot installs from a bare mirror of the checkout", (t) => {
    const { dir, repo, data, commit } = fixture(t);
    const mirror = join(dir, "mirror.git");

    commit("two");
    execFileSync("git", ["clone", "--bare", "--quiet", repo, mirror]);
    const info = installSlot(data, { repo: mirror, ref: "main", by: "test" });

    assert.equal(
        readFileSync(join(slotDir(data, info.id), "src", "server", "main.ts"), "utf8"),
        'console.log("two");\n',
    );
    assert.equal(info.source, "main");
});

/** The real launcher, on `data`, until `done` holds or 20 seconds pass; then it stops. */
async function launcher(
    data: string,
    done: () => boolean,
    env: NodeJS.ProcessEnv = {},
): Promise<void> {
    const proc = spawn(
        process.execPath,
        [
            LAUNCHER,
            "--access",
            "local",
            "--port",
            String(40_000 + Math.floor(Math.random() * 20_000)),
            "--data",
            data,
            "--cwd",
            data,
        ],
        {
            stdio: "ignore",
            env: { ...process.env, NO_COLOR: "1", PI_TALARIA_NO_SLOT: "1", ...env },
        },
    );
    const exited = once(proc, "exit");

    try {
        for (let waited = 0; !done(); waited += 100) {
            assert.ok(waited < 20_000, "the launcher did not get there");
            assert.equal(proc.exitCode, null, "the launcher stopped");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    } finally {
        proc.kill("SIGTERM");
        await exited;
    }
}

/** A stand-in server that marks `file` when it starts, says it is ready, and stays. */
const goodServer = (file: string) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(file)}, process.env.PI_TALARIA_TRIAL ?? "");
process.send?.({ type: "ready" });
process.on("disconnect", () => process.exit(0));
setInterval(() => {}, 60_000);
`;

test("the launcher goes back from a release that does not start", async (t) => {
    const { data, dir } = fixture(t);
    const started = join(dir, "started-a");

    mkdirSync(data, { recursive: true });
    handSlot(data, "aaaaaaaaaaaa", goodServer(started));
    handSlot(data, "bbbbbbbbbbbb", "process.exit(1);\n");
    setCurrent(data, "aaaaaaaaaaaa", "test");
    setCurrent(data, "bbbbbbbbbbbb", "test");
    writeTrial(data, { v: 1, slot: "bbbbbbbbbbbb", from: "aaaaaaaaaaaa", at: 0, crashes: 0 });

    await launcher(data, () => existsSync(started));
    assert.equal(pointedSlot(data, "current"), "aaaaaaaaaaaa");
    assert.match(readLedger(data, 1)[0]?.note ?? "", /did not start/);
    // The slot it went back to is not on trial.
    assert.equal(readFileSync(started, "utf8"), "");
});

test("the launcher goes back from a release that keeps crashing, and passes one that does not", async (t) => {
    const { data, dir } = fixture(t);
    const startedA = join(dir, "started-a");
    const startedC = join(dir, "started-c");

    mkdirSync(data, { recursive: true });
    handSlot(data, "aaaaaaaaaaaa", goodServer(startedA));
    handSlot(
        data,
        "bbbbbbbbbbbb",
        'process.send?.({ type: "ready" });\nsetTimeout(() => process.exit(1), 100);\n',
    );
    handSlot(data, "cccccccccccc", goodServer(startedC));
    setCurrent(data, "aaaaaaaaaaaa", "test");
    setCurrent(data, "bbbbbbbbbbbb", "test");
    writeTrial(data, { v: 1, slot: "bbbbbbbbbbbb", from: "aaaaaaaaaaaa", at: 0, crashes: 0 });

    await launcher(data, () => existsSync(startedA));
    assert.equal(pointedSlot(data, "current"), "aaaaaaaaaaaa");
    assert.match(readLedger(data, 1)[0]?.note ?? "", /stopped 2 times on trial/);

    setCurrent(data, "cccccccccccc", "test");
    writeTrial(data, { v: 1, slot: "cccccccccccc", from: "aaaaaaaaaaaa", at: 0, crashes: 0 });
    await launcher(data, () => readTrial(data) === undefined, { PI_TALARIA_TRIAL_WATCH_MS: "500" });
    assert.equal(readFileSync(startedC, "utf8"), "1");
    assert.equal(pointedSlot(data, "current"), "cccccccccccc");
    assert.deepEqual(
        readLedger(data, 1).map((entry) => [entry.event, entry.slot]),
        [["good", "cccccccccccc"]],
    );
});

test("the app finds a new commit at the source, installs it, and switches to it on trial", async (t) => {
    const { repo, data, commit } = fixture(t);
    let restarts = 0;

    mkdirSync(data, { recursive: true });
    const first = installSlot(data, { repo, by: "test" });

    setCurrent(data, first.id, "test");
    writeSource(data, { v: 1, url: repo, branch: "main", seed: repo });
    makeDatabase(data);

    const manager = new ReleaseManager({ data, supervised: true, restart: () => restarts++ });

    assert.equal((await manager.check()).available, undefined);

    const next = commit("two");
    const checked = await manager.check();

    assert.equal(checked.available?.commit.slice(0, 12), next);
    assert.deepEqual(
        checked.available?.commits.map((each) => each.subject),
        ["two"],
    );

    const updated = await manager.update();

    assert.equal(updated.current, next);
    assert.equal(updated.previous, first.id);
    assert.equal(updated.trial?.slot, next);
    assert.equal(updated.trial?.from, first.id);
    assert.ok(updated.trial?.snapshot !== undefined && existsSync(updated.trial.snapshot));
    assert.deepEqual(
        readLedger(data, 4).map((entry) => [entry.event, entry.by]),
        [
            ["switch", "app"],
            ["snapshot", "app"],
            ["install", "app"],
            ["switch", "test"],
        ],
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(restarts, 1);
    await assert.rejects(manager.update(), /on trial/);

    // Going back from the app is a switch on trial too.
    rmSync(join(data, "releases", "trial.json"));
    const back = await manager.rollback(first.id);

    assert.equal(back.current, first.id);
    assert.equal(back.trial?.slot, first.id);
    await assert.rejects(manager.rollback("0123456789ab"), /not installed/);
});

// ─── Data versions ──────────────────────────────────────────────────────

/** A data-version.ts as a release would have it. */
const declaring = (version: number, readableFrom: number) =>
    `export const DATA_VERSION = ${version};\nexport const READABLE_FROM = ${readableFrom};\n`;

function declaredSlot(data: string, id: string, version?: number, readableFrom = 0): void {
    handSlot(data, id, "");

    if (version !== undefined) {
        writeFileSync(
            join(slotDir(data, id), "src", "server", "data-version.ts"),
            declaring(version, readableFrom),
        );
    }
}

test("this code's declaration reads back, and a release from before declares version 0", (t) => {
    const { data } = fixture(t);
    const root = fileURLToPath(new URL("..", import.meta.url));

    mkdirSync(data, { recursive: true });
    assert.deepEqual(declarationOf(root), { version: 1, readableFrom: 0 });
    declaredSlot(data, "aaaaaaaaaaaa");
    assert.deepEqual(declarationOf(slotDir(data, "aaaaaaaaaaaa")), { version: 0, readableFrom: 0 });
});

test("the data version only moves forward, and a release that cannot read the data is refused", (t) => {
    const { data } = fixture(t);

    mkdirSync(data, { recursive: true });
    declaredSlot(data, "aaaaaaaaaaaa");
    declaredSlot(data, "bbbbbbbbbbbb", 1, 0);
    declaredSlot(data, "cccccccccccc", 2, 0);
    declaredSlot(data, "dddddddddddd", 3, 2);

    // Nothing declared has run: everything may run.
    assert.equal(readDataVersion(data), undefined);
    assert.deepEqual(preflight(data, "aaaaaaaaaaaa").problems, []);

    // Expands: older releases still read the data.
    noteDataVersion(data, { version: 1, readableFrom: 0 }, "bbbbbbbbbbbb", 1);
    noteDataVersion(data, { version: 2, readableFrom: 0 }, "cccccccccccc", 2);
    assert.deepEqual(preflight(data, "aaaaaaaaaaaa").problems, []);

    // An older release running again moves nothing back.
    noteDataVersion(data, { version: 1, readableFrom: 0 }, "bbbbbbbbbbbb", 3);
    assert.equal(readDataVersion(data)?.version, 2);

    // A contract: switching to it warns first, and after it ran, releases before version 2 are refused.
    assert.match(preflight(data, "dddddddddddd").warnings[0] ?? "", /before data version 2/);
    noteDataVersion(data, { version: 3, readableFrom: 2 }, "dddddddddddd", 4);
    assert.deepEqual(readDataVersion(data), {
        v: 1,
        version: 3,
        readableFrom: 2,
        at: 4,
        slot: "dddddddddddd",
    });
    assert.match(preflight(data, "bbbbbbbbbbbb").problems[0] ?? "", /cannot run on this data/);
    assert.match(preflight(data, "aaaaaaaaaaaa").problems[0] ?? "", /cannot run on this data/);
    assert.deepEqual(preflight(data, "cccccccccccc").problems, []);
    assert.match(preflight(data, "eeeeeeeeeeee").problems[0] ?? "", /not installed/);
});

test("the commands and the app refuse to go back to a release that cannot read the data", async (t) => {
    const { data } = fixture(t);
    const run = (...args: string[]) =>
        spawnSync(process.execPath, [BIN, ...args, "--data", data], {
            encoding: "utf8",
            env: { ...process.env, PI_POCKET_DIR: undefined, PI_TALARIA_NO_SLOT: undefined },
        });

    mkdirSync(data, { recursive: true });
    declaredSlot(data, "aaaaaaaaaaaa", 1, 0);
    declaredSlot(data, "bbbbbbbbbbbb", 2, 2);
    setCurrent(data, "aaaaaaaaaaaa", "test");
    setCurrent(data, "bbbbbbbbbbbb", "test");
    noteDataVersion(data, { version: 2, readableFrom: 2 }, "bbbbbbbbbbbb");

    const refused = run("rollback");

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot run on this data[\s\S]*--force/);
    assert.equal(pointedSlot(data, "current"), "bbbbbbbbbbbb");
    assert.match(
        run("versions").stdout,
        /Data version 2[\s\S]*aaaaaaaaaaaa cannot be gone back to/,
    );

    const manager = new ReleaseManager({ data, supervised: true, restart: () => {} });

    assert.match(manager.status().blocked.aaaaaaaaaaaa ?? "", /cannot run on this data/);
    await assert.rejects(manager.rollback("aaaaaaaaaaaa"), /cannot run on this data/);
    assert.equal(pointedSlot(data, "current"), "bbbbbbbbbbbb");

    const forced = run("rollback", "--force");

    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(pointedSlot(data, "current"), "aaaaaaaaaaaa");
});

test("a failed trial that moved the data past the release before restores the copy and its version", (t) => {
    const { data } = fixture(t);

    mkdirSync(data, { recursive: true });
    declaredSlot(data, "aaaaaaaaaaaa", 1, 0);
    declaredSlot(data, "bbbbbbbbbbbb", 2, 2);
    setCurrent(data, "aaaaaaaaaaaa", "test");
    makeDatabase(data);
    noteDataVersion(data, { version: 1, readableFrom: 0 }, "aaaaaaaaaaaa", 1);

    const before = readDataVersion(data)!;
    const snapshot = snapshotDatabase(data, "before-b", "test", 2);

    writeTrial(data, {
        v: 1,
        slot: "bbbbbbbbbbbb",
        from: "aaaaaaaaaaaa",
        at: 2,
        crashes: 0,
        snapshot,
        schema: schemaHash(snapshot),
        dataVersion: before,
    });
    setCurrent(data, "bbbbbbbbbbbb", "test");
    // The new release ran, rewrote rows in place (no schema change), and moved the data to version 2.
    makeDatabase(data);
    noteDataVersion(data, { version: 2, readableFrom: 2 }, "bbbbbbbbbbbb", 3);
    assert.match(failTrial(data, "it crashed", "test")!, /database went back/);
    assert.equal(rows(data), 1);
    assert.deepEqual(readDataVersion(data), before);
    assert.deepEqual(preflight(data, "aaaaaaaaaaaa").problems, []);
});

test("a server refuses data a newer release made unreadable to it", (t) => {
    const { data } = fixture(t);
    const main = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));

    mkdirSync(data, { recursive: true });
    noteDataVersion(data, { version: 9, readableFrom: 5 });

    const started = spawnSync(
        process.execPath,
        [main, "--data", data, "--socket", join(data, "s.sock")],
        { encoding: "utf8", env: { ...process.env, PI_TALARIA_TRIAL: undefined }, timeout: 60_000 },
    );

    assert.equal(started.status, 78, started.stderr);
    assert.match(started.stderr, /cannot open the data[\s\S]*version 9/);
    assert.equal(existsSync(databasePath(data)), false, "it opened nothing");
});
