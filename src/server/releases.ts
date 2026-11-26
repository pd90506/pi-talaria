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

export type LedgerEvent = "install" | "switch" | "rollback" | "prune";

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
    previous: string;
    ledger: string;
}

export function releasePaths(data: string): ReleasePaths {
    const root = join(data, RELEASES_DIR);

    return {
        root,
        slots: join(root, "slots"),
        current: join(root, "current.json"),
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
        // A private index: the checkout's own index and files stay as they are.
        git(repo, ["read-tree", commit], { GIT_INDEX_FILE: index });
        git(repo, ["checkout-index", "--all", "--force", `--prefix=${temp}/`], {
            GIT_INDEX_FILE: index,
        });

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
