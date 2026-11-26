/**
 * Releases: the versions of pi-talaria that the app keeps for itself, so that the code that runs is never a folder that
 * someone edits. Each release is a slot, `releases/slots/<id>/` in the data folder: one commit's files and its
 * packages. The source files of a slot are read-only. `releases/current.json` names the slot that the launcher runs,
 * `releases/previous.json` the one before, and `releases/ledger.jsonl` keeps a line for each install, switch, and
 * rollback. The launcher and the `versions` / `rollback` / `release` commands import this module, so it imports only
 * Node's own modules and runs no server code: keep it so.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The folder in the data folder. */
export const RELEASES_DIR = "releases";

/** How many slots `pruneSlots` keeps by default, current and previous among them. */
export const KEEP_SLOTS = 5;

/** A slot's id: the first 12 hex digits of its commit. */
const SLOT_ID = /^[0-9a-f]{12}$/;

/** What is known about a slot, kept beside it as `slots/<id>.json`. */
export interface SlotInfo {
    v: 1;
    id: string;
    /** The full commit. */
    commit: string;
    /** `package.json`'s version. */
    version: string;
    /** Where it came from, in words: `main`, a branch, or a folder. */
    source: string;
    installedAt: number;
    /** A hash of `package-lock.json`: slots with the same one can share their packages. */
    lock: string;
}

/** Which slot runs, as `current.json` and `previous.json` hold it. */
export interface Pointer {
    slot: string;
    at: number;
}

export type LedgerEvent = "install" | "switch" | "rollback" | "prune" | "good" | "snapshot";

/** One line of `ledger.jsonl`. */
export interface LedgerEntry {
    at: number;
    event: LedgerEvent;
    slot: string;
    /** The slot that ran before, for a switch or a rollback. */
    from?: string;
    /** Who did it: `cli`, `app`, or `launcher`. */
    by: string;
    note?: string;
}

export interface ReleasePaths {
    root: string;
    slots: string;
    current: string;
    /** A switch on trial: the launcher goes back when the new slot does not start or keeps failing. */
    trial: string;
    /** Copies of the database, made before a switch. */
    snapshots: string;
    /** Where new releases come from (`ReleaseSource`). */
    source: string;
    /** The app's own bare clone of the source, which new slots are installed from. */
    mirror: string;
    previous: string;
    ledger: string;
}

export function releasePaths(data: string): ReleasePaths {
    const root = join(data, RELEASES_DIR);

    return {
        root,
        slots: join(root, "slots"),
        current: join(root, "current.json"),
        trial: join(root, "trial.json"),
        snapshots: join(root, "snapshots"),
        source: join(root, "source.json"),
        mirror: join(root, "repo.git"),
        previous: join(root, "previous.json"),
        ledger: join(root, "ledger.jsonl"),
    };
}

export function slotDir(data: string, id: string): string {
    return join(releasePaths(data).slots, id);
}

/** Whether `appRoot` is a slot of some data folder: `…/releases/slots/<id>`. */
export function isSlotRoot(appRoot: string): boolean {
    const root = resolve(appRoot);

    return (
        SLOT_ID.test(basename(root)) &&
        basename(dirname(root)) === "slots" &&
        basename(dirname(dirname(root))) === RELEASES_DIR
    );
}

/** A slot that is complete: its folder, its server, and its record are there. */
export function slotReady(data: string, id: string): boolean {
    return (
        SLOT_ID.test(id) &&
        existsSync(join(slotDir(data, id), "src", "server", "main.ts")) &&
        readSlot(data, id) !== undefined
    );
}

export function readSlot(data: string, id: string): SlotInfo | undefined {
    if (!SLOT_ID.test(id)) {
        return undefined;
    }

    try {
        const info = JSON.parse(
            readFileSync(join(releasePaths(data).slots, `${id}.json`), "utf8"),
        ) as SlotInfo;

        return info?.v === 1 && info.id === id ? info : undefined;
    } catch {
        return undefined;
    }
}

/** Every complete slot, newest install first. */
export function listSlots(data: string): SlotInfo[] {
    let names: string[];

    try {
        names = readdirSync(releasePaths(data).slots);
    } catch {
        return [];
    }

    return names
        .filter((name) => SLOT_ID.test(name) && slotReady(data, name))
        .map((name) => readSlot(data, name)!)
        .sort((a, b) => b.installedAt - a.installedAt);
}

function readPointerFile(file: string): Pointer | undefined {
    try {
        const pointer = JSON.parse(readFileSync(file, "utf8")) as Pointer;

        return typeof pointer?.slot === "string" && SLOT_ID.test(pointer.slot)
            ? pointer
            : undefined;
    } catch {
        return undefined;
    }
}

/** The slot that `current.json` (or `previous.json`) names, when that slot is complete. */
export function pointedSlot(data: string, which: "current" | "previous"): string | undefined {
    const pointer = readPointerFile(releasePaths(data)[which]);

    return pointer !== undefined && slotReady(data, pointer.slot) ? pointer.slot : undefined;
}

/** Write a small file all at once: a reader sees the old one or the new one, never part of one. */
function writeAtomic(file: string, text: string): void {
    const temp = `${file}.${process.pid}.tmp`;

    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
}

export function appendLedger(data: string, entry: LedgerEntry): void {
    const paths = releasePaths(data);

    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    appendFileSync(paths.ledger, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The ledger, newest first; `limit` lines at most. Lines that do not parse are skipped. */
export function readLedger(data: string, limit = Infinity): LedgerEntry[] {
    let text: string;

    try {
        text = readFileSync(releasePaths(data).ledger, "utf8");
    } catch {
        return [];
    }

    const entries: LedgerEntry[] = [];

    for (const line of text.split("\n").reverse()) {
        if (entries.length >= limit) {
            break;
        }

        if (line.trim() === "") {
            continue;
        }

        try {
            entries.push(JSON.parse(line) as LedgerEntry);
        } catch {
            // A line cut short by a crash: the rest still count.
        }
    }

    return entries;
}

/**
 * Make `id` the current slot. The slot that was current becomes the previous one (unless it is `id` itself), and the
 * ledger gets a line. The launcher starts the new slot at the server's next start.
 */
export function setCurrent(
    data: string,
    id: string,
    by: string,
    event: "switch" | "rollback" = "switch",
    note?: string,
    now = Date.now(),
): { from: string | undefined } {
    if (!slotReady(data, id)) {
        throw new Error(`Release ${id} is not installed`);
    }

    const paths = releasePaths(data);
    const from = pointedSlot(data, "current");

    mkdirSync(paths.root, { recursive: true, mode: 0o700 });

    if (from !== undefined && from !== id) {
        writeAtomic(paths.previous, `${JSON.stringify({ slot: from, at: now })}\n`);
    }

    writeAtomic(paths.current, `${JSON.stringify({ slot: id, at: now })}\n`);
    appendLedger(data, {
        at: now,
        event,
        slot: id,
        ...(from === undefined ? {} : { from }),
        by,
        ...(note === undefined ? {} : { note }),
    });

    return { from };
}

/** The source tree of a slot, which no one edits: everything but `node_modules`. */
function walkSource(dir: string, visit: (path: string, isDir: boolean) => void): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") {
            continue;
        }

        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            walkSource(path, visit);
            visit(path, true);
        } else if (entry.isFile()) {
            visit(path, false);
        }
    }
}

/** Take the write bits off a slot's source files and folders (files first, then folders, deepest first). */
export function makeReadOnly(dir: string): void {
    walkSource(dir, (path) => {
        chmodSync(path, statSync(path).mode & ~0o222);
    });
    chmodSync(dir, statSync(dir).mode & ~0o222);
}

/** Give the owner write access again, so that the slot can be removed. */
export function makeWritable(dir: string): void {
    if (!existsSync(dir)) {
        return;
    }

    chmodSync(dir, statSync(dir).mode | 0o200);

    const visit = (path: string) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);

            if (entry.isDirectory()) {
                chmodSync(child, statSync(child).mode | 0o200);
                visit(child);
            } else if (entry.isFile()) {
                chmodSync(child, statSync(child).mode | 0o200);
            }
        }
    };

    visit(dir);
}

/**
 * Copy a folder tree with hard links where the file system allows them, and plain copies where it does not. Slots
 * with the same lock file share their packages this way: a few megabytes of links instead of a copy each.
 */
export function linkTree(from: string, to: string, link = true): void {
    mkdirSync(to, { recursive: true });

    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);

        if (entry.isDirectory()) {
            linkTree(source, target, link);
        } else if (entry.isSymbolicLink()) {
            symlinkSync(readlinkSync(source), target);
        } else if (entry.isFile()) {
            if (link) {
                try {
                    linkSync(source, target);
                    continue;
                } catch {
                    // Another file system, or links not allowed: copy it.
                }
            }

            copyFileSync(source, target);
        }
    }
}

function lockHash(dir: string): string {
    try {
        return createHash("sha256")
            .update(readFileSync(join(dir, "package-lock.json")))
            .digest("hex")
            .slice(0, 16);
    } catch {
        return "";
    }
}

type Lock = { packages?: Record<string, { version?: string }> };

/** Whether `node_modules` holds what `package-lock.json` asks for, as npm's own record of it there says. */
export function modulesMatchLock(dir: string): boolean {
    try {
        const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as Lock;
        const installed = JSON.parse(
            readFileSync(join(dir, "node_modules", ".package-lock.json"), "utf8"),
        ) as Lock;
        const wanted = Object.entries(lock.packages ?? {}).filter(([path]) => path !== "");
        const have = installed.packages ?? {};

        return (
            wanted.length === Object.keys(have).length &&
            wanted.every(([path, entry]) => have[path]?.version === entry.version)
        );
    } catch {
        return false;
    }
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
    const result = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    }

    return result.stdout.trim();
}

/** `npm ci` in `dir`, as the slot installer runs it unless a test gives its own. */
export function npmCi(dir: string): void {
    const result = spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--omit=dev"], {
        cwd: dir,
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`npm ci failed: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
    }
}

export interface InstallOptions {
    /** A git checkout of pi-talaria. */
    repo: string;
    /** What to install: a commit, branch, or tag in `repo`. HEAD when not given. */
    ref?: string;
    /** Where it came from, in words, for the ledger. The branch or ref when not given. */
    source?: string;
    by: string;
    /** Installs the packages of a slot whose lock no other slot shares. `npmCi` when not given. */
    install?: (dir: string) => void;
    now?: number;
}

/**
 * Install a commit of `repo` as a slot, or return the slot that has it already. The files come from git (only what
 * the commit holds: no local changes, no build output), the packages from a slot or the checkout with the same lock
 * file, or from `npm ci` when there is none. The slot is built in a temporary folder and renamed into place when
 * complete, so a slot that exists is whole.
 */
export function installSlot(data: string, options: InstallOptions): SlotInfo {
    const repo = resolve(options.repo);
    const ref = options.ref ?? "HEAD";
    const commit = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const id = commit.slice(0, 12);
    const existing = readSlot(data, id);

    if (existing !== undefined && slotReady(data, id)) {
        return existing;
    }

    const paths = releasePaths(data);
    const dir = slotDir(data, id);
    const temp = join(paths.slots, `.tmp-${id}-${process.pid}`);
    const index = join(paths.slots, `.index-${id}-${process.pid}`);

    mkdirSync(paths.slots, { recursive: true, mode: 0o700 });
    makeWritable(temp);
    rmSync(temp, { recursive: true, force: true });

    try {
        // A private index and the temporary folder as the work tree: the checkout's own index and files stay as they
        // are, and a bare repository (the app's mirror) works the same way.
        const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
        const env = { GIT_INDEX_FILE: index, GIT_DIR: gitDir, GIT_WORK_TREE: temp };

        mkdirSync(temp, { recursive: true });
        git(temp, ["read-tree", commit], env);
        git(temp, ["checkout-index", "--all", "--force"], env);

        const lock = lockHash(temp);
        const donor = [
            ...listSlots(data).map((slot) => ({
                dir: slotDir(data, slot.id),
                lock: slot.lock,
                link: true,
            })),
            // The checkout's packages are copied, not linked: a link would share its files' modes with the slot. They
            // count only when npm installed them from this lock: a pull without `npm ci` leaves the old ones.
            { dir: repo, lock: modulesMatchLock(repo) ? lockHash(repo) : "", link: false },
        ].find(
            (each) =>
                each.lock !== "" &&
                each.lock === lock &&
                existsSync(join(each.dir, "node_modules")),
        );

        if (donor !== undefined) {
            linkTree(join(donor.dir, "node_modules"), join(temp, "node_modules"), donor.link);
        } else {
            (options.install ?? npmCi)(temp);
        }

        let version = "0.0.0";

        try {
            version =
                (
                    JSON.parse(readFileSync(join(temp, "package.json"), "utf8")) as {
                        version?: string;
                    }
                ).version ?? version;
        } catch {
            // A commit without a package.json still installs; its version shows as 0.0.0.
        }

        let source = options.source;

        if (source === undefined) {
            try {
                source = ref === "HEAD" ? git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) : ref;
            } catch {
                source = ref;
            }
        }

        const info: SlotInfo = {
            v: 1,
            id,
            commit,
            version,
            source,
            installedAt: options.now ?? Date.now(),
            lock,
        };

        makeReadOnly(temp);
        makeWritable(dir);
        rmSync(dir, { recursive: true, force: true });
        renameSync(temp, dir);
        writeAtomic(join(paths.slots, `${id}.json`), `${JSON.stringify(info)}\n`);
        appendLedger(data, {
            at: info.installedAt,
            event: "install",
            slot: id,
            by: options.by,
            note: `${version} from ${source}`,
        });

        return info;
    } catch (error) {
        makeWritable(temp);
        rmSync(temp, { recursive: true, force: true });

        throw error;
    } finally {
        rmSync(index, { force: true });
    }
}

/**
 * Remove the oldest slots past `keep`. The current and previous slots stay, and so do the ones `alsoKeep` names (the
 * slot the running launcher came from, say). Returns the ids removed.
 */
export function pruneSlots(
    data: string,
    keep = KEEP_SLOTS,
    alsoKeep: string[] = [],
    by = "app",
    now = Date.now(),
): string[] {
    const kept = new Set(
        [pointedSlot(data, "current"), pointedSlot(data, "previous"), ...alsoKeep].filter(
            (id): id is string => id !== undefined,
        ),
    );
    const slots = listSlots(data);
    const room = Math.max(0, keep - slots.filter((slot) => kept.has(slot.id)).length);
    const removed: string[] = [];
    let others = 0;

    for (const slot of slots) {
        if (kept.has(slot.id)) {
            continue;
        }

        if (others < room) {
            others++;
            continue;
        }

        const dir = slotDir(data, slot.id);

        makeWritable(dir);
        rmSync(dir, { recursive: true, force: true });
        rmSync(join(releasePaths(data).slots, `${slot.id}.json`), { force: true });
        appendLedger(data, { at: now, event: "prune", slot: slot.id, by });
        removed.push(slot.id);
    }

    return removed;
}

/** The slot that a launcher or server whose code is in `appRoot` came from, or undefined for a checkout. */
export function slotOf(appRoot: string): string | undefined {
    return isSlotRoot(appRoot) ? basename(resolve(appRoot)) : undefined;
}

// ─── Trials ─────────────────────────────────────────────────────────────

/** How long a new slot runs on trial after it is ready: two crashes in this time send it back. */
export const TRIAL_WATCH_MS = Number(process.env.PI_TALARIA_TRIAL_WATCH_MS) || 10 * 60_000;
/** How long a slot on trial may take to be ready. */
export const TRIAL_START_MS = 3 * 60_000;
/** Crashes after it was ready that end a trial with a rollback. */
export const TRIAL_CRASHES = 2;

/** A switch on trial, as `trial.json` holds it. */
export interface Trial {
    v: 1;
    /** The slot on trial, and the slot to go back to. */
    slot: string;
    from: string;
    at: number;
    /** When the slot on trial first said it was ready. */
    readyAt?: number;
    crashes: number;
    /** The database copy made before the switch, and its schema then (`schemaHash`). */
    snapshot?: string;
    schema?: string;
}

export function readTrial(data: string): Trial | undefined {
    try {
        const trial = JSON.parse(readFileSync(releasePaths(data).trial, "utf8")) as Trial;

        return trial?.v === 1 && SLOT_ID.test(trial.slot) && SLOT_ID.test(trial.from)
            ? trial
            : undefined;
    } catch {
        return undefined;
    }
}

export function writeTrial(data: string, trial: Trial): void {
    mkdirSync(releasePaths(data).root, { recursive: true, mode: 0o700 });
    writeAtomic(releasePaths(data).trial, `${JSON.stringify(trial)}\n`);
}

/** The trial passed: the slot is good. */
export function passTrial(data: string, by: string, now = Date.now()): void {
    const trial = readTrial(data);

    rmSync(releasePaths(data).trial, { force: true });

    if (trial !== undefined) {
        appendLedger(data, { at: now, event: "good", slot: trial.slot, by });
    }
}

/**
 * The slot on trial failed: make the slot before it current again. When the database's schema changed since the
 * snapshot (the new version migrated it), the snapshot goes back too, after a copy of the database as it is now. Runs
 * between two starts of the server, with no server holding the database. Returns what was done, in words, or undefined
 * when no trial is under way.
 */
export function failTrial(
    data: string,
    reason: string,
    by: string,
    now = Date.now(),
): string | undefined {
    const trial = readTrial(data);

    if (trial === undefined) {
        return undefined;
    }

    rmSync(releasePaths(data).trial, { force: true });

    if (!slotReady(data, trial.from)) {
        appendLedger(data, {
            at: now,
            event: "rollback",
            slot: trial.slot,
            by,
            note: `${reason}; release ${trial.from} to go back to is gone`,
        });

        return `Release ${trial.slot} failed (${reason}), and release ${trial.from} is gone: staying on ${trial.slot}.`;
    }

    let restored = "";

    if (trial.snapshot !== undefined && trial.schema !== undefined && existsSync(trial.snapshot)) {
        const db = databasePath(data);

        if (existsSync(db) && schemaHash(db) !== trial.schema) {
            snapshotDatabase(data, `before-restore-${trial.slot}`, by, now);
            restoreDatabase(data, trial.snapshot);
            restored = "; the database went back to its copy from before the switch";
        }
    }

    setCurrent(data, trial.from, by, "rollback", `${reason}${restored}`, now);

    return `Release ${trial.slot} failed (${reason}): back on release ${trial.from}${restored}.`;
}

// ─── Database snapshots ─────────────────────────────────────────────────

/** The database every conversation lives in. */
export function databasePath(data: string): string {
    return join(data, "pocket.sqlite");
}

type Sqlite = typeof import("node:sqlite");

/** node:sqlite, loaded when used: Node 22 warns that it is experimental, which the launcher need not print at every start. */
function sqlite(): Sqlite {
    return process.getBuiltinModule("node:sqlite") as Sqlite;
}

/** A hash of the database's schema: its tables, indexes, and `user_version`. A migration changes it. */
export function schemaHash(db: string): string {
    const database = new (sqlite().DatabaseSync)(db, { readOnly: true });

    try {
        const rows = database
            .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .all();
        const version = database.prepare("PRAGMA user_version").get();

        return createHash("sha256")
            .update(JSON.stringify([rows, version]))
            .digest("hex")
            .slice(0, 16);
    } finally {
        database.close();
    }
}

/**
 * A consistent copy of the database (`VACUUM INTO`, which reads it in one transaction, also while the server writes
 * to it), in `releases/snapshots/`. Returns its path.
 */
export function snapshotDatabase(
    data: string,
    label: string,
    by: string,
    now = Date.now(),
): string {
    const folder = releasePaths(data).snapshots;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const file = join(folder, `${stamp}-${label.replace(/[^A-Za-z0-9_-]/g, "_")}.sqlite`);
    const database = new (sqlite().DatabaseSync)(databasePath(data));

    mkdirSync(folder, { recursive: true, mode: 0o700 });

    try {
        database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    } finally {
        database.close();
    }

    appendLedger(data, { at: now, event: "snapshot", slot: label, by, note: basename(file) });

    return file;
}

/** Put a snapshot in place of the database. Only with no server running: the old WAL and shared memory go too. */
export function restoreDatabase(data: string, snapshot: string): void {
    const db = databasePath(data);
    const temp = `${db}.restore-${process.pid}`;

    copyFileSync(snapshot, temp);
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    renameSync(temp, db);
}

/** The snapshots, newest first. */
export function listSnapshots(data: string): string[] {
    try {
        return readdirSync(releasePaths(data).snapshots)
            .filter((name) => name.endsWith(".sqlite"))
            .sort()
            .reverse()
            .map((name) => join(releasePaths(data).snapshots, name));
    } catch {
        return [];
    }
}

/** Remove all but the newest `keep` snapshots, and never the one a trial still needs. */
export function pruneSnapshots(data: string, keep = KEEP_SLOTS): void {
    const needed = readTrial(data)?.snapshot;

    for (const file of listSnapshots(data).slice(keep)) {
        if (file !== needed) {
            rmSync(file, { force: true });
        }
    }
}

// ─── Where releases come from ───────────────────────────────────────────

/** `source.json`: the repository and branch that new releases come from. */
export interface ReleaseSource {
    v: 1;
    /** The git address to fetch from, like `https://github.com/pd90506/pi-talaria.git`. */
    url: string;
    branch: string;
    /** A local checkout of it, which the mirror is first cloned from: a full clone over a slow line takes long. */
    seed?: string;
}

export function readSource(data: string): ReleaseSource | undefined {
    try {
        const source = JSON.parse(readFileSync(releasePaths(data).source, "utf8")) as ReleaseSource;

        return source?.v === 1 &&
            typeof source.url === "string" &&
            typeof source.branch === "string"
            ? source
            : undefined;
    } catch {
        return undefined;
    }
}

export function writeSource(data: string, source: ReleaseSource): void {
    mkdirSync(releasePaths(data).root, { recursive: true, mode: 0o700 });
    writeAtomic(releasePaths(data).source, `${JSON.stringify(source)}\n`);
}

/** The source a checkout gives: its `origin`, and `main`. Undefined when it has no origin. */
export function sourceOfCheckout(repo: string): ReleaseSource | undefined {
    try {
        const url = git(repo, ["remote", "get-url", "origin"]);

        return url === "" ? undefined : { v: 1, url, branch: "main", seed: resolve(repo) };
    } catch {
        return undefined;
    }
}
