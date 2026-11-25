/**
 * Core's own secrets, kept out of what Pi and people read:
 *
 * - `CoreSecrets.sync` gives each secret core keeps to `HiddenValues` (as `host.hide` does), in every session, PiP and
 *   subagents too: every `secret: true` setting of a module (its value and its default), `ownerToken`, the private key
 *   in `push.json`, the keys in Pi's `auth.json`, and any file a part of core adds (`watchFile`). It runs when the owner
 *   saves settings, and before each command and after each tool, where it reads again only a file that changed. A value
 *   that changes stays hidden as the old one too, for the life of the process: the old value may still be in use.
 *
 * Hiding is by value, as `host.hide` is: a command that transforms a value on purpose (encodes it, splits it) shows it.
 * It is no boundary between Pi and the files of the user it runs as.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConfigStore } from "./config.ts";
import type { SettingField } from "./extension-settings.ts";
import { type HiddenValues, MAX_HIDDEN, MIN_HIDDEN } from "./hidden.ts";

/** One secret found: its value, and what shows in its place. */
export interface FoundSecret {
    value: string;
    label: string;
}

/** A file that holds secrets: what of its text they are. */
export interface SecretFile {
    path: string;
    read: (text: string) => FoundSecret[];
}

export interface CoreSecretsOptions {
    hidden: HiddenValues;
    config: ConfigStore;
    dataDir: string;
    agentDir: string;
    /** The settings a module that is on declares (`ExtensionWebs.settingsOf`). */
    settingsOf: (module: string) => readonly SettingField[] | undefined;
    log: (line: string) => void;
}

/** The most old values kept hidden after they changed, so a server that keeps changing them does not fill the list. */
const MAX_RETIRED = 200;
/** Fields of `auth.json` that hold keys and tokens. */
const AUTH_FIELD = /key|token|secret|access|refresh|password|credential|cookie|session/i;
/** The fewest characters core hides of its own: a shorter one would hide ordinary output. */
const MIN_OWN = 8;

function label(text: string): string {
    const clean = text.replace(/[^A-Za-z0-9 _.:-]+/g, "-").slice(0, 60);

    return clean === "" ? "secret" : clean;
}

/** `.env`, `.env.local`, `.plane.env`, `prod.env`: a file of variables. Templates (`.env.example`) are not. */
export function isEnvFile(name: string): boolean {
    const lower = name.toLowerCase();

    if (lower === ".env") {
        return true;
    }

    if (lower.startsWith(".env.")) {
        return !/^\.env\.(example|sample|template|dist|defaults)$/.test(lower);
    }

    return lower.length > 4 && lower.endsWith(".env");
}

export class CoreSecrets {
    readonly #options: CoreSecretsOptions;
    /** What is hidden now, by value: the value's label, and how to stop hiding it. */
    readonly #hidden = new Map<string, () => void>();
    /** Values that were secrets and changed: still hidden, oldest first. */
    readonly #retired: string[] = [];
    readonly #files = new Map<string, SecretFile>();
    /** What each file held when last read, by path: its size and time, so an unchanged file is not read again. */
    readonly #read = new Map<string, { stamp: string; found: FoundSecret[] }>();
    #syncing = false;

    constructor(options: CoreSecretsOptions) {
        this.#options = options;
        this.watchFile({
            path: join(options.dataDir, "push.json"),
            read: (text) => {
                const key = (JSON.parse(text) as { vapid?: { privateKey?: unknown } }).vapid
                    ?.privateKey;

                return typeof key === "string" ? [{ value: key, label: "push private key" }] : [];
            },
        });
        this.watchFile({
            path: join(options.agentDir, "auth.json"),
            read: (text) => authSecrets(JSON.parse(text)),
        });
    }

    /** Hide what a file holds, and keep Pi from it (a part of core that keeps a secret of its own in a file). */
    watchFile(file: SecretFile): void {
        this.#files.set(resolve(file.path), file);
        this.#read.delete(resolve(file.path));
    }

    /** The files core keeps secrets in: `config.json`, and each watched one. */
    files(): string[] {
        return [join(this.#options.dataDir, "config.json"), ...this.#files.keys()];
    }

    /** What is hidden now, as labels: for tests and the log, never the values. */
    labels(): string[] {
        return [...this.#current().map((each) => each.label)].sort();
    }

    /** Hide each secret found now, in every session. A value no longer found stays hidden, as an old value. */
    sync(): void {
        // A file read below can log, and a log line can come back here: one sync at a time.
        if (this.#syncing) {
            return;
        }

        this.#syncing = true;

        try {
            const found = this.#current();
            const now = new Set(found.map((each) => each.value));

            for (const { value, label: name } of found) {
                if (this.#hidden.has(value)) {
                    const at = this.#retired.indexOf(value);

                    if (at !== -1) {
                        this.#retired.splice(at, 1);
                    }

                    continue;
                }

                try {
                    this.#hidden.set(value, this.#options.hidden.add({ value, label: name }));
                } catch (error) {
                    // Full, or out of bounds: the log says which secret, never its value.
                    this.#options.log(
                        `Core secrets: ${name} is not hidden: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            for (const value of this.#hidden.keys()) {
                if (!now.has(value) && !this.#retired.includes(value)) {
                    this.#retired.push(value);
                }
            }

            while (this.#retired.length > MAX_RETIRED) {
                const value = this.#retired.shift()!;

                this.#hidden.get(value)?.();
                this.#hidden.delete(value);
            }
        } finally {
            this.#syncing = false;
        }
    }

    #current(): FoundSecret[] {
        const { config } = this.#options;
        const found: FoundSecret[] = [{ value: config.ownerToken, label: "owner token" }];

        for (const module of config.extensionSettingModules()) {
            const stored = config.extensionSettings(module);

            // A module that is off declares no settings: which of its values are secret is unknown, so none is hidden.
            // One hidden while it was on stays hidden, as an old value.
            for (const field of this.#options.settingsOf(module) ?? []) {
                if (field.type !== "text" || field.secret !== true) {
                    continue;
                }

                const name = label(`secret ${module}.${field.name}`);

                for (const value of [stored[field.name], field.default]) {
                    if (typeof value === "string") {
                        found.push({ value, label: name });
                    }
                }
            }
        }

        for (const [path, file] of this.#files) {
            found.push(...this.#readFile(path, file));
        }

        return found.filter(
            (each) =>
                each.value.length >= Math.max(MIN_HIDDEN, MIN_OWN) &&
                each.value.length <= MAX_HIDDEN,
        );
    }

    #readFile(path: string, file: SecretFile): FoundSecret[] {
        let stamp: string;

        try {
            const stat = statSync(path);

            stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
        } catch {
            this.#read.delete(path);

            return [];
        }

        const known = this.#read.get(path);

        if (known?.stamp === stamp) {
            return known.found;
        }

        let found: FoundSecret[];

        try {
            found = file.read(readFileSync(path, "utf8"));
        } catch {
            // Half written, or not what it should be: what it held before stays hidden, and the next sync reads it again.
            return known?.found ?? [];
        }

        this.#read.set(path, { stamp, found });

        return found;
    }
}

/** Every key and token in Pi's `auth.json`, by provider. */
function authSecrets(parsed: unknown): FoundSecret[] {
    const found: FoundSecret[] = [];

    if (typeof parsed !== "object" || parsed === null) {
        return found;
    }

    const walk = (value: unknown, provider: string, field: string) => {
        if (typeof value === "string") {
            if (AUTH_FIELD.test(field)) {
                found.push({ value, label: label(`auth ${provider}`) });
            }
        } else if (Array.isArray(value)) {
            for (const each of value) {
                walk(each, provider, field);
            }
        } else if (typeof value === "object" && value !== null) {
            for (const [key, each] of Object.entries(value)) {
                walk(each, provider, key);
            }
        }
    };

    for (const [provider, entry] of Object.entries(parsed)) {
        walk(entry, provider, "");
    }

    return found;
}
