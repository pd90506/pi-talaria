/**
 * The app's side of releases (`releases.ts`): see what is new in the release source, install it as a slot, and switch to
 * it on trial, with a copy of the database first; or go back to a slot that is kept. The switch restarts the server; the
 * launcher then runs the new slot on trial and goes back by itself when it fails. Owner-only routes under
 * `/api/releases` (`http/api.ts`) call it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";
import {
    type LedgerEntry,
    listSlots,
    pointedSlot,
    pruneSlots,
    pruneSnapshots,
    readLedger,
    readSlot,
    readSource,
    readTrial,
    releasePaths,
    type ReleaseSource,
    schemaHash,
    setCurrent,
    type SlotInfo,
    slotOf,
    slotReady,
    snapshotDatabase,
    databasePath,
    type Trial,
    writeTrial,
} from "./releases.ts";

/** How often the source is looked at by itself. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;

export interface Commit {
    sha: string;
    subject: string;
}

export interface ReleaseStatus {
    /** The slot this server runs from, or undefined for a checkout. */
    running?: string;
    current?: string;
    previous?: string;
    slots: SlotInfo[];
    ledger: LedgerEntry[];
    trial?: Trial;
    source?: ReleaseSource;
    /** The source's newest commit, when it is not the current slot's, and the commits it adds. */
    available?: { commit: string; commits: Commit[] };
    checkedAt?: number;
    /** What an update or a rollback is doing now. */
    step?: string;
    error?: string;
    /** The launcher runs the server: without it, nothing can switch or go back. */
    supervised: boolean;
}

export interface ReleaseManagerOptions {
    data: string;
    supervised: boolean;
    /** Restart the server, which the launcher starts from the current slot. */
    restart: () => void;
    log?: (line: string) => void;
    /** Runs `pi-pocket release install` for an update; tests give their own. */
    install?: (args: string[]) => Promise<void>;
    now?: () => number;
}

/** Run a command; its output, or an error with the end of what it said. */
function run(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";

        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0
                ? resolve(out.trim())
                : reject(
                      new Error(
                          `${command} ${args[0]} failed: ${(err || out).trim().slice(-1500)}`,
                      ),
                  ),
        );
    });
}

export class ReleaseManager {
    readonly #options: ReleaseManagerOptions;
    #available: ReleaseStatus["available"];
    #checkedAt: number | undefined;
    #step: string | undefined;
    #error: string | undefined;
    #busy: Promise<unknown> | undefined;
    #timer: NodeJS.Timeout | undefined;

    constructor(options: ReleaseManagerOptions) {
        this.#options = options;
    }

    get #data(): string {
        return this.#options.data;
    }

    #now(): number {
        return this.#options.now?.() ?? Date.now();
    }

    /** Look at the source now and then, while the server runs. */
    start(): void {
        if (this.#timer !== undefined || readSource(this.#data) === undefined) {
            return;
        }

        this.#timer = setInterval(() => void this.check().catch(() => {}), CHECK_EVERY_MS);
        this.#timer.unref();
    }

    stop(): void {
        clearInterval(this.#timer);
        this.#timer = undefined;
    }

    status(): ReleaseStatus {
        const trial = readTrial(this.#data);
        const source = readSource(this.#data);
        const running = slotOf(APP_ROOT);
        const current = pointedSlot(this.#data, "current");
        const previous = pointedSlot(this.#data, "previous");

        return {
            ...(running === undefined ? {} : { running }),
            ...(current === undefined ? {} : { current }),
            ...(previous === undefined ? {} : { previous }),
            slots: listSlots(this.#data),
            ledger: readLedger(this.#data, 50),
            ...(trial === undefined ? {} : { trial }),
            ...(source === undefined ? {} : { source }),
            ...(this.#available === undefined ? {} : { available: this.#available }),
            ...(this.#checkedAt === undefined ? {} : { checkedAt: this.#checkedAt }),
            ...(this.#step === undefined ? {} : { step: this.#step }),
            ...(this.#error === undefined ? {} : { error: this.#error }),
            supervised: this.#options.supervised,
        };
    }

    /** One update, check, or rollback at a time. */
    async #exclusive<T>(work: () => Promise<T>): Promise<T> {
        if (this.#busy !== undefined) {
            throw new Error(this.#step ?? "Another release step is under way.");
        }

        const promise = work();

        this.#busy = promise;

        try {
            return await promise;
        } finally {
            this.#busy = undefined;
            this.#step = undefined;
        }
    }

    /** The app's own bare clone of the source, made once from the seed checkout (or the address), then fetched. */
    async #mirror(source: ReleaseSource): Promise<string> {
        const mirror = releasePaths(this.#data).mirror;

        if (!existsSync(join(mirror, "HEAD"))) {
            const from =
                source.seed !== undefined && existsSync(source.seed) ? source.seed : source.url;

            this.#step = "Cloning the release source";
            await run("git", ["clone", "--bare", "--quiet", from, mirror]);
            await run("git", ["-C", mirror, "remote", "set-url", "origin", source.url]);
        }

        this.#step = `Fetching ${source.branch}`;
        await run("git", [
            "-C",
            mirror,
            "fetch",
            "--quiet",
            "origin",
            `+refs/heads/${source.branch}:refs/heads/${source.branch}`,
        ]);

        return mirror;
    }

    /** Fetch the source and say whether it has a newer commit than the current slot. */
    check(): Promise<ReleaseStatus> {
        return this.#exclusive(async () => {
            const source = readSource(this.#data);

            if (source === undefined) {
                throw new Error(
                    "No release source: install a release once with `pi-pocket release install --switch` from a checkout.",
                );
            }

            try {
                const mirror = await this.#mirror(source);
                const tip = await run("git", [
                    "-C",
                    mirror,
                    "rev-parse",
                    `refs/heads/${source.branch}`,
                ]);
                const current = pointedSlot(this.#data, "current");
                const base =
                    current === undefined ? undefined : readSlot(this.#data, current)?.commit;

                if (base === tip) {
                    this.#available = undefined;
                } else {
                    let commits: Commit[] = [];

                    try {
                        const range = base === undefined ? ["-20", tip] : [`${base}..${tip}`];
                        const log = await run("git", [
                            "-C",
                            mirror,
                            "log",
                            "--format=%H%x09%s",
                            ...range,
                        ]);

                        commits = log
                            .split("\n")
                            .filter((line) => line !== "")
                            .slice(0, 50)
                            .map((line) => {
                                const [sha = "", ...subject] = line.split("\t");

                                return { sha, subject: subject.join("\t") };
                            });
                    } catch {
                        // A base the source does not have (a slot from a branch): no list, the update still works.
                    }

                    this.#available = { commit: tip, commits };
                }

                this.#checkedAt = this.#now();
                this.#error = undefined;
            } catch (error) {
                this.#error = (error as Error).message;

                throw error;
            }

            return this.status();
        });
    }

    #install(args: string[]): Promise<void> {
        if (this.#options.install !== undefined) {
            return this.#options.install(args);
        }

        // The command runs as its own process: `npm ci` can take minutes, and the server keeps answering meanwhile.
        return run(process.execPath, [join(APP_ROOT, "bin", "pi-pocket.js"), ...args]).then(
            () => {},
        );
    }

    /**
     * Switch to `slot` on trial: a copy of the database first, then the slot current, then a restart. The launcher
     * starts the slot and goes back by itself when it does not start, fails its checks, or keeps crashing.
     */
    #switch(slot: string, event: "switch" | "rollback", note?: string): void {
        if (!this.#options.supervised) {
            throw new Error(
                "Start pi-talaria with bin/pi-pocket.js: only its launcher can switch releases.",
            );
        }

        const from = pointedSlot(this.#data, "current") ?? slotOf(APP_ROOT);
        const now = this.#now();
        let snapshot: string | undefined;
        let schema: string | undefined;

        if (existsSync(databasePath(this.#data))) {
            this.#step = "Copying the database";
            snapshot = snapshotDatabase(this.#data, `before-${slot}`, "app", now);
            schema = schemaHash(snapshot);
            pruneSnapshots(this.#data);
        }

        if (from !== undefined && from !== slot && slotReady(this.#data, from)) {
            writeTrial(this.#data, {
                v: 1,
                slot,
                from,
                at: now,
                crashes: 0,
                ...(snapshot === undefined ? {} : { snapshot }),
                ...(schema === undefined ? {} : { schema }),
            });
        }

        setCurrent(this.#data, slot, "app", event, note, now);
        this.#step = "Restarting";
        this.#options.log?.(`Switching to release ${slot}; restarting.`);
        setTimeout(() => this.#options.restart(), 200);
    }

    /** Install the source's newest commit (fetched by `check`) and switch to it. */
    update(): Promise<ReleaseStatus> {
        return this.#exclusive(async () => {
            const source = readSource(this.#data);

            if (source === undefined) {
                throw new Error("No release source.");
            }

            if (readTrial(this.#data) !== undefined) {
                throw new Error(
                    "A release is on trial now: wait until it passes, or go back from it.",
                );
            }

            try {
                const mirror = await this.#mirror(source);
                const tip = await run("git", [
                    "-C",
                    mirror,
                    "rev-parse",
                    `refs/heads/${source.branch}`,
                ]);
                const id = tip.slice(0, 12);

                if (id === pointedSlot(this.#data, "current")) {
                    this.#available = undefined;

                    return this.status();
                }

                this.#step = `Installing release ${id}`;
                await this.#install([
                    "release",
                    "install",
                    "--from",
                    mirror,
                    "--ref",
                    tip,
                    "--source",
                    source.branch,
                    "--by",
                    "app",
                    "--data",
                    this.#data,
                ]);

                if (!slotReady(this.#data, id)) {
                    throw new Error(`Release ${id} did not install.`);
                }

                pruneSlots(
                    this.#data,
                    undefined,
                    [slotOf(APP_ROOT)].filter((each) => each !== undefined),
                );
                this.#available = undefined;
                this.#error = undefined;
                this.#switch(
                    id,
                    "switch",
                    `${readSlot(this.#data, id)?.version ?? ""} from ${source.branch}`.trim(),
                );
            } catch (error) {
                this.#error = (error as Error).message;

                throw error;
            }

            return this.status();
        });
    }

    /** Go back to a kept slot, on trial like an update. Its code may not read data that a newer one migrated. */
    rollback(slot: string): Promise<ReleaseStatus> {
        return this.#exclusive(async () => {
            if (!slotReady(this.#data, slot)) {
                throw new Error(`Release ${slot} is not installed.`);
            }

            if (slot === pointedSlot(this.#data, "current")) {
                throw new Error(`Release ${slot} is the current one.`);
            }

            this.#switch(slot, "rollback", "from the app");

            return this.status();
        });
    }
}
