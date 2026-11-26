/**
 * Dev instances: pi-talaria run from a thread's worktree in sandbox mode (`sandbox.ts`), on a copy of the real data,
 * beside the real server, to try a change before it is merged and released. Each one listens on a Unix socket of its
 * own and, where Tailscale runs, is served at a tailnet port of its own (`https://<machine>:10443/`). At most three run
 * at once; they stop with the real server.
 *
 * Pi starts them with the `dev_instance` tool (`extensions/dev-instances.ts`); the owner sees and stops them in the
 * Versions sheet (`/api/dev` in `http/api.ts`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    cpSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { APP_ROOT } from "./config.ts";
import {
    copyDatabase,
    databasePath,
    linkTree,
    modulesMatchLock,
    pointedSlot,
    slotDir,
} from "./releases.ts";

export const DEV_DIR = "dev";
/** The tailnet ports dev instances are served at, in order; PI_TALARIA_DEV_PORTS changes them (`10443,10444`). */
export const DEV_PORTS = [10443, 10444, 10445];
/** How long a dev instance may take to answer once started. */
const READY_MS = 3 * 60_000;
/** What a log keeps: the end of it, so a server that writes much does not fill the disk. */
const LOG_LIMIT = 2 * 1024 * 1024;

/**
 * What the data copy leaves out: the database (copied apart, consistently), locks and run files of the real server,
 * its releases and worktrees, other dev instances, and background commands' files (the real server's processes).
 */
const NOT_COPIED = new Set([
    "pocket.sqlite",
    "pocket.sqlite-wal",
    "pocket.sqlite-shm",
    "harness.lock",
    "harness.lock.identity",
    "launcher.lock",
    "launcher.lock.identity",
    "launcher-running.json",
    "serve-mount.json",
    "releases",
    DEV_DIR,
    "worktrees",
    "background",
]);

export type DevStatus = "starting" | "running" | "stopped" | "failed";

export interface DevInstance {
    id: string;
    label: string;
    /** The checkout or worktree it runs from. */
    worktree: string;
    /** The commit it started on, when the folder is a git checkout. */
    commit?: string;
    port: number;
    socket: string;
    data: string;
    status: DevStatus;
    pid?: number;
    startedAt: number;
    /** Where the owner opens it: the tailnet address, when Tailscale serves it. */
    url?: string;
    error?: string;
}

export interface DevInstancesOptions {
    /** The real server's data folder. */
    data: string;
    /** Pi's own folder (sign-ins, settings): shared, never copied, when it is in the data folder. */
    agentDir?: string;
    log?: (line: string) => void;
    /** Serve a socket at a tailnet port; the address, or undefined where nothing serves it. Tests give their own. */
    expose?: (port: number, socket: string) => Promise<string | undefined>;
    unexpose?: (port: number) => Promise<void>;
    /** Make a folder's packages ready; tests give their own. */
    prepare?: (worktree: string) => Promise<void>;
    ports?: number[];
    now?: () => number;
}

/** Run a command; its output, or an error with the end of what it said. */
function run(command: string, args: string[], cwd?: string, timeoutMs = 30_000): Promise<string> {
    return new Promise((done, fail) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: process.platform === "win32",
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.on("error", (error) => {
            clearTimeout(timer);
            fail(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);

            if (code === 0) {
                done(out.trim());
            } else {
                fail(
                    new Error(`${command} ${args[0]} failed: ${(err || out).trim().slice(-1500)}`),
                );
            }
        });
    });
}

/** `tailscale serve` for a dev instance's socket: its tailnet address, or undefined when Tailscale is not there. */
export async function tailscaleExpose(port: number, socket: string): Promise<string | undefined> {
    if (process.env.PI_TALARIA_DEV_EXPOSE === "0") {
        return undefined;
    }

    const binary = process.env.PI_TALARIA_TAILSCALE ?? "tailscale";
    let name: string;

    try {
        const status = JSON.parse(await run(binary, ["status", "--json"])) as {
            Self?: { DNSName?: string };
        };

        name = status.Self?.DNSName?.replace(/\.$/, "") ?? "";
    } catch {
        return undefined;
    }

    if (name === "") {
        return undefined;
    }

    await run(binary, ["serve", "--bg", `--https=${port}`, `unix:${socket}`]);

    return `https://${name}:${port}/`;
}

export async function tailscaleUnexpose(port: number): Promise<void> {
    if (process.env.PI_TALARIA_DEV_EXPOSE === "0") {
        return;
    }

    await run(process.env.PI_TALARIA_TAILSCALE ?? "tailscale", [
        "serve",
        `--https=${port}`,
        "off",
    ]).catch(() => {});
}

/**
 * A folder's packages, for a worktree that has none (git leaves `node_modules` out): links to the packages of the
 * real server's code or its current release when the lock file is the same, else `npm ci`.
 */
export async function preparePackages(worktree: string, data: string): Promise<void> {
    if (modulesMatchLock(worktree)) {
        return;
    }

    let lock: string;

    try {
        lock = readFileSync(join(worktree, "package-lock.json"), "utf8");
    } catch {
        throw new Error(`${worktree} has no package-lock.json: is it a pi-talaria checkout?`);
    }

    const current = pointedSlot(data, "current");
    const candidates = [APP_ROOT, ...(current === undefined ? [] : [slotDir(data, current)])];

    for (const candidate of candidates) {
        try {
            if (
                readFileSync(join(candidate, "package-lock.json"), "utf8") === lock &&
                modulesMatchLock(candidate)
            ) {
                rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
                linkTree(join(candidate, "node_modules"), join(worktree, "node_modules"));

                return;
            }
        } catch {
            // Not this one.
        }
    }

    await run("npm", ["ci", "--no-audit", "--no-fund", "--omit=dev"], worktree, 15 * 60_000);
}

/** The top folder of the git repository `cwd` is in, or undefined. */
export function repositoryRoot(cwd: string): Promise<string | undefined> {
    return run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).then(
        (root) => root || undefined,
        () => undefined,
    );
}

/** A process by pid still runs. */
function alive(pid: number | undefined): boolean {
    if (pid === undefined || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Whether a process runs with `text` on its command line (Linux); elsewhere, whether it runs at all. */
function runsWith(pid: number, text: string): boolean {
    if (!alive(pid)) {
        return false;
    }

    try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(text);
    } catch {
        return process.platform !== "linux";
    }
}

/** Ask the server on a socket for its page: true once it answers as itself, not as "starting". */
function answers(socket: string): Promise<boolean> {
    return new Promise((done) => {
        const asked = request(
            { socketPath: socket, path: "/", method: "GET", timeout: 2000 },
            (response) => {
                response.resume();
                done(response.statusCode !== undefined && response.statusCode < 500);
            },
        );

        asked.on("error", () => done(false));
        asked.on("timeout", () => {
            asked.destroy();
            done(false);
        });
        asked.end();
    });
}

/** The last `lines` lines of a file. */
export function tail(file: string, lines = 80): string {
    let fd: number;

    try {
        fd = openSync(file, "r");
    } catch {
        return "";
    }

    try {
        const size = statSync(file).size;
        const length = Math.min(size, 256 * 1024);
        const buffer = Buffer.alloc(length);

        readSync(fd, buffer, 0, length, size - length);

        return buffer
            .toString("utf8")
            .split("\n")
            .slice(-lines - 1)
            .join("\n")
            .trim();
    } finally {
        closeSync(fd);
    }
}

export class DevInstances {
    readonly #options: DevInstancesOptions;
    readonly #children = new Map<string, ChildProcess>();
    /** One start, restart, or stop at a time for each instance. */
    readonly #busy = new Map<string, Promise<unknown>>();
    #list: DevInstance[];

    constructor(options: DevInstancesOptions) {
        this.#options = options;
        this.#list = this.#read();

        // What the last real server left running stopped with it, or is stopped now: its parent is gone.
        let changed = false;

        for (const each of this.#list) {
            if (each.status === "running" || each.status === "starting") {
                if (each.pid !== undefined && runsWith(each.pid, each.data)) {
                    try {
                        process.kill(each.pid, "SIGTERM");
                    } catch {
                        // Gone meanwhile.
                    }
                }

                each.status = "stopped";
                delete each.pid;
                changed = true;
                void this.#unexpose(each.port);
            }
        }

        if (changed) {
            this.#write();
        }
    }

    get #root(): string {
        return join(this.#options.data, DEV_DIR);
    }

    get #file(): string {
        return join(this.#root, "instances.json");
    }

    #now(): number {
        return this.#options.now?.() ?? Date.now();
    }

    #log(line: string): void {
        this.#options.log?.(line);
    }

    #read(): DevInstance[] {
        try {
            const list = JSON.parse(readFileSync(this.#file, "utf8")) as DevInstance[];

            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    #write(): void {
        mkdirSync(this.#root, { recursive: true, mode: 0o700 });

        const temp = `${this.#file}.${process.pid}`;

        writeFileSync(temp, `${JSON.stringify(this.#list, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, this.#file);
    }

    #ports(): number[] {
        const env = process.env.PI_TALARIA_DEV_PORTS?.split(",")
            .map((each) => Number(each.trim()))
            .filter((each) => Number.isInteger(each) && each > 0);

        return this.#options.ports ?? (env !== undefined && env.length > 0 ? env : DEV_PORTS);
    }

    list(): DevInstance[] {
        return this.#list.map((each) => ({ ...each }));
    }

    get(idOrWorktree: string): DevInstance | undefined {
        const path = resolve(idOrWorktree);

        return this.#list.find((each) => each.id === idOrWorktree || each.worktree === path);
    }

    logs(id: string, lines = 80): string {
        const instance = this.get(id);

        return instance === undefined
            ? ""
            : tail(join(this.#root, instance.id, "server.log"), lines);
    }

    async #exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
        if (this.#busy.has(id)) {
            throw new Error("That dev instance is starting or stopping already: wait a moment.");
        }

        const promise = work();

        this.#busy.set(id, promise);

        try {
            return await promise;
        } finally {
            this.#busy.delete(id);
        }
    }

    /**
     * Start a dev instance from `worktree` (a pi-talaria checkout), or restart the one it has. `fresh` copies the real
     * data again; otherwise a restart keeps the copy it has, so what was tried there stays.
     */
    start(
        worktree: string,
        options: { label?: string; fresh?: boolean } = {},
    ): Promise<DevInstance> {
        const folder = resolve(worktree);
        const id = createHash("sha256").update(folder).digest("hex").slice(0, 8);

        return this.#exclusive(id, async () => {
            if (!existsSync(join(folder, "src", "server", "main.ts"))) {
                throw new Error(
                    `${folder} is not a pi-talaria checkout: it has no src/server/main.ts.`,
                );
            }

            const data = this.#options.data;

            if (folder === data || folder.startsWith(`${resolve(data)}${sep}${DEV_DIR}${sep}`)) {
                throw new Error(
                    "A dev instance runs from a checkout or worktree, not from a data folder.",
                );
            }

            let instance = this.#list.find((each) => each.id === id);

            if (instance !== undefined) {
                await this.#halt(instance);
            }

            const taken = new Set(
                this.#list
                    .filter(
                        (each) =>
                            each.id !== id && each.status !== "stopped" && each.status !== "failed",
                    )
                    .map((each) => each.port),
            );
            const port =
                instance !== undefined && !taken.has(instance.port)
                    ? instance.port
                    : this.#ports().find((each) => !taken.has(each));

            if (port === undefined) {
                throw new Error(
                    `${taken.size} dev instances run already, the most there may be: stop one first.`,
                );
            }

            const dir = join(this.#root, id);
            const copy = join(dir, "data");
            const socket = join(dir, "pocket.sock");
            const label =
                options.label?.trim().slice(0, 40) ||
                instance?.label ||
                relative(join(folder, ".."), folder);

            mkdirSync(dir, { recursive: true, mode: 0o700 });

            if (options.fresh === true || !existsSync(join(copy, "pocket.sqlite"))) {
                this.#copyData(copy);
            }

            const commit = await run("git", ["-C", folder, "rev-parse", "HEAD"]).catch(
                () => undefined,
            );

            instance = {
                id,
                label,
                worktree: folder,
                ...(commit === undefined ? {} : { commit }),
                port,
                socket,
                data: copy,
                status: "starting",
                startedAt: this.#now(),
            };
            this.#list = [...this.#list.filter((each) => each.id !== id), instance];
            this.#write();

            try {
                await (this.#options.prepare ?? ((path) => preparePackages(path, data)))(folder);
                this.#spawn(instance, dir);
                await this.#ready(instance);
                instance.status = "running";

                try {
                    const url = await (this.#options.expose ?? tailscaleExpose)(port, socket);

                    if (url !== undefined) {
                        instance.url = url;
                    }
                } catch (error) {
                    instance.error = `Running, but Tailscale did not serve it: ${(error as Error).message}`;
                }

                this.#log(
                    `Dev instance ${label} runs from ${folder}${instance.url ? ` at ${instance.url}` : ""}.`,
                );
            } catch (error) {
                instance.status = "failed";
                instance.error = (error as Error).message;
                this.#children.get(id)?.kill("SIGTERM");
                delete instance.pid;
            }

            this.#write();

            return { ...instance };
        });
    }

    /** A copy of the real data: the database consistently (`VACUUM INTO`), the rest as files. */
    #copyData(copy: string): void {
        const data = this.#options.data;
        const agent = this.#options.agentDir;

        rmSync(copy, { recursive: true, force: true });
        mkdirSync(copy, { recursive: true, mode: 0o700 });

        // Entry by entry: the copy is inside the data folder, which a copy of the whole folder refuses.
        for (const name of readdirSync(data)) {
            const source = join(data, name);

            // Pi's own folder, when it is in the data folder, stays shared: a sign-in refreshed twice can end one.
            if (
                NOT_COPIED.has(name) ||
                (agent !== undefined && resolve(source) === resolve(agent))
            ) {
                continue;
            }

            cpSync(source, join(copy, name), { recursive: true, verbatimSymlinks: true });
        }

        if (existsSync(databasePath(data))) {
            copyDatabase(databasePath(data), join(copy, "pocket.sqlite"));
        }
    }

    #spawn(instance: DevInstance, dir: string): void {
        const log = join(dir, "server.log");

        try {
            if (statSync(log).size > LOG_LIMIT) {
                writeFileSync(log, `${tail(log, 400)}\n`);
            }
        } catch {
            // No log yet.
        }

        appendFileSync(
            log,
            `\n--- ${new Date(this.#now()).toISOString()} start ${instance.commit?.slice(0, 12) ?? ""} from ${instance.worktree}\n`,
        );
        rmSync(instance.socket, { force: true });

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PI_TALARIA_SANDBOX: instance.label || "1",
            PI_POCKET_DIR: instance.data,
            // A sandbox is no launcher's: it restarts nothing, rolls nothing back, runs no release.
            PI_POCKET_SUPERVISED: undefined,
            PI_POCKET_LAUNCHER: undefined,
            PI_POCKET_ROLLBACK: undefined,
            PI_POCKET_NPM_ROLLBACK: undefined,
            PI_POCKET_SOCKET: undefined,
            PI_POCKET_HOST: undefined,
            PI_POCKET_PORT: undefined,
            PI_TALARIA_RELEASE: undefined,
            PI_TALARIA_TRIAL: undefined,
        };
        const child = spawn(
            process.execPath,
            [
                "--disable-warning=ExperimentalWarning",
                join(instance.worktree, "src", "server", "main.ts"),
                "--socket",
                instance.socket,
                "--data",
                instance.data,
                "--cwd",
                instance.worktree,
            ],
            { cwd: instance.worktree, env, stdio: ["ignore", "pipe", "pipe"] },
        );

        const write = (chunk: Buffer) => {
            try {
                appendFileSync(log, chunk);
            } catch {
                // The folder went: nothing to keep it in.
            }
        };

        child.stdout?.on("data", write);
        child.stderr?.on("data", write);
        child.on("error", (error) => write(Buffer.from(`${error.message}\n`)));
        child.on("exit", (code, signal) => {
            write(Buffer.from(`--- exited ${signal ?? code}\n`));

            if (this.#children.get(instance.id) !== child) {
                return;
            }

            this.#children.delete(instance.id);

            const current = this.#list.find((each) => each.id === instance.id);

            // A stop, or a start that failed, says so itself.
            if (current !== undefined && current.status === "running") {
                current.status = "failed";
                current.error = `It stopped (${signal ?? `exit code ${code}`}); its log says why.`;
                delete current.pid;
                void this.#unexpose(current.port);
                this.#write();
            }
        });
        this.#children.set(instance.id, child);

        if (child.pid !== undefined) {
            instance.pid = child.pid;
        }
    }

    async #ready(instance: DevInstance): Promise<void> {
        const until = Date.now() + READY_MS;

        while (Date.now() < until) {
            const child = this.#children.get(instance.id);

            if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
                throw new Error(
                    `It stopped while starting. The end of its log:\n${this.logs(instance.id, 20)}`,
                );
            }

            if (existsSync(instance.socket) && (await answers(instance.socket))) {
                return;
            }

            await new Promise((done) => setTimeout(done, 300));
        }

        throw new Error(`It did not answer within ${READY_MS / 60_000} minutes.`);
    }

    async #unexpose(port: number): Promise<void> {
        await (this.#options.unexpose ?? tailscaleUnexpose)(port).catch(() => {});
    }

    /** Stop an instance's process and its tailnet address; its data copy and log stay. */
    async #halt(instance: DevInstance): Promise<void> {
        const child = this.#children.get(instance.id);

        instance.status = "stopped";
        delete instance.url;
        delete instance.error;

        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((done) => child.once("exit", done));

            child.kill("SIGTERM");

            const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);

            await exited;
            clearTimeout(timer);
        }

        this.#children.delete(instance.id);
        delete instance.pid;
        await this.#unexpose(instance.port);
    }

    stop(idOrWorktree: string): Promise<DevInstance> {
        const instance = this.get(idOrWorktree);

        if (instance === undefined) {
            return Promise.reject(new Error("No such dev instance."));
        }

        return this.#exclusive(instance.id, async () => {
            await this.#halt(instance);
            this.#write();

            return { ...instance };
        });
    }

    restart(idOrWorktree: string, fresh = false): Promise<DevInstance> {
        const instance = this.get(idOrWorktree);

        if (instance === undefined) {
            return Promise.reject(new Error("No such dev instance: start one first."));
        }

        return this.start(instance.worktree, { label: instance.label, fresh });
    }

    /** Stop them all, when the real server stops. */
    async close(): Promise<void> {
        await Promise.all(
            this.#list
                .filter((each) => this.#children.has(each.id))
                .map((each) => this.#halt(each).catch(() => {})),
        );
        this.#write();
    }
}
