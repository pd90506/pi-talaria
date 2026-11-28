/**
 * Developing pi-talaria from inside it (Versions → Develop): the repository the person works on (pi-talaria itself when
 * this machine's `gh` account can push to it, else that account's fork, made now), the local checkouts of it this
 * machine has, and a clone of it made in a place the person picked. The Projects extension uses it for its develop
 * project and that project's `project_repo` tool.
 */
import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { APP_ROOT } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { apiArgs, type Gh, parseRepo, repoArgs, repoInfo, sameRepo } from "./github.ts";
import { git } from "./git.ts";
import { readSource } from "./releases.ts";

/** The develop project's name. */
export const DEVELOP_NAME = "Develop pi-talaria";

/** pi-talaria's own repository, when neither the release source nor this checkout names one. */
const HOME_REPO = "pd90506/pi-talaria";

/** How long a clone may take: a full one over a slow line takes long. */
const CLONE_TIMEOUT_MS = 30 * 60_000;

/** How long GitHub may take to make a fork it said it is making. */
const FORK_WAIT_MS = 60_000;

const httpsUrl = (repo: string): string => {
    const { host, path } = repoArgs(repo);

    return `https://${host ?? "github.com"}/${path}.git`;
};

/** The repository pi-talaria comes from here: the release source's (Versions), else this checkout's `origin`. */
export async function upstreamRepo(dataDir: string): Promise<string> {
    const source = readSource(dataDir);
    const fromSource = source === undefined ? undefined : parseRepo(source.url);

    if (fromSource !== undefined) {
        return fromSource;
    }

    const origin = await git(APP_ROOT, ["remote", "get-url", "origin"]).then(
        (out) => parseRepo(out.trim()),
        () => undefined,
    );

    return origin ?? HOME_REPO;
}

/** Who this machine's `gh` is signed in as on github.com. Throws a 403 that says how to sign in. */
async function ghLogin(gh: Gh): Promise<string> {
    try {
        const login = (await gh(["api", "user", "--jq", ".login"])).trim();

        if (/^[A-Za-z0-9-]{1,39}$/.test(login)) {
            return login;
        }
    } catch (error) {
        throw new HttpError(
            403,
            `This server's gh is not signed in to GitHub (${describe(error)}). Run gh auth login on it, then press Develop again.`,
        );
    }

    throw new HttpError(403, "This server's gh did not say who it is signed in as.");
}

/** A repository by `owner/name`, as GitHub has it, or undefined when there is none. */
async function lookUp(
    gh: Gh,
    repo: string,
): Promise<{ full_name?: string; fork?: boolean; parent?: { full_name?: string } } | undefined> {
    try {
        return JSON.parse(await gh(apiArgs(repo, `repos/${repoArgs(repo).path}`))) as {
            full_name?: string;
            fork?: boolean;
            parent?: { full_name?: string };
        };
    } catch (error) {
        if (/not found|404/i.test(describe(error))) {
            return undefined;
        }

        throw new HttpError(502, `GitHub could not be asked about ${repo}: ${describe(error)}`);
    }
}

/** The repository the person develops in: `upstream` itself when they can push to it, or their fork of it. */
export type DevelopCopy = {
    /** Where their changes go: `owner/name`. */
    repository: string;
    /** pi-talaria's repository, when `repository` is a fork of it. */
    upstream?: string;
    /** The fork was made now. */
    forked: boolean;
};

/**
 * The person's own copy of `upstream` on GitHub: `upstream` when `gh`'s account can push to it, else that account's
 * fork of it, made now when it has none. A repository of the same name that is not a fork of it is refused.
 */
export async function githubCopy(
    gh: Gh,
    upstream: string,
    wait = (ms: number) => new Promise((done) => setTimeout(done, ms)),
): Promise<DevelopCopy> {
    const login = await ghLogin(gh);
    const info = await repoInfo(gh, upstream);

    if (info.push) {
        return { repository: info.repo, forked: false };
    }

    if (repoArgs(info.repo).host !== undefined) {
        throw new HttpError(
            400,
            `This server's gh account cannot push to ${info.repo}, and Develop makes forks on github.com only.`,
        );
    }

    const name = info.repo.split("/").at(-1)!;
    const mine = `${login}/${name}`;
    const isFork = (found: Awaited<ReturnType<typeof lookUp>>): boolean =>
        found?.fork === true && sameRepo(found.parent?.full_name, info.repo);
    let found = await lookUp(gh, mine);

    if (found !== undefined && !isFork(found)) {
        throw new HttpError(
            409,
            `${mine} is there on GitHub and is not a fork of ${info.repo}. Rename or remove it, then press Develop again.`,
        );
    }

    const forked = found === undefined;

    if (forked) {
        try {
            await gh(["repo", "fork", info.repo, "--clone=false", "--default-branch-only"]);
        } catch (error) {
            throw new HttpError(502, `GitHub did not fork ${info.repo}: ${describe(error)}`);
        }

        // GitHub makes a fork a moment after it says it will.
        for (const start = Date.now(); Date.now() - start < FORK_WAIT_MS; await wait(2000)) {
            found = await lookUp(gh, mine);

            if (found !== undefined) {
                break;
            }
        }

        if (!isFork(found)) {
            throw new HttpError(
                502,
                `GitHub has not shown the fork ${mine} yet. Press Develop again in a minute.`,
            );
        }
    }

    const repository = parseRepo(found!.full_name ?? mine) ?? mine;

    return { repository, upstream: info.repo, forked };
}

/** The GitHub repositories a folder's remotes point at, as its config names them (before any `insteadOf`). */
async function remotesOf(folder: string): Promise<string[]> {
    const out = await git(folder, ["config", "--get-regexp", "^remote\\..*\\.url$"], {
        allowExit: [1],
    }).catch(() => "");

    return [
        ...new Set(
            out
                .split("\n")
                .map((line) => parseRepo(line.split(/\s+/)[1] ?? ""))
                .filter((repo): repo is string => repo !== undefined),
        ),
    ];
}

/** `~/x` as an absolute path. */
export function expandPath(path: string): string {
    const trimmed = path.trim();

    return trimmed === "~"
        ? homedir()
        : trimmed.startsWith("~/")
          ? join(homedir(), trimmed.slice(2))
          : trimmed;
}

/**
 * Why `folder` is not a checkout of the project's repository: it must be the top of a git checkout with a remote at
 * `repository` (or at `upstream`, pi-talaria's own). Undefined when it is one.
 */
export async function notACheckout(
    folder: string,
    repos: { repository: string; upstream?: string },
): Promise<string | undefined> {
    if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
        return `${folder} is not a folder on this machine.`;
    }

    const top = await git(folder, ["rev-parse", "--show-toplevel"]).then(
        (out) => resolve(out.trim()),
        () => undefined,
    );

    if (top !== resolve(folder)) {
        return top === undefined
            ? `${folder} is not a git checkout.`
            : `${folder} is inside the checkout ${top}: give its top folder.`;
    }

    const remotes = await remotesOf(folder);
    const wanted = [repos.repository, repos.upstream].filter(
        (each): each is string => each !== undefined,
    );

    if (!remotes.some((remote) => wanted.some((each) => sameRepo(remote, each)))) {
        return `${folder} is a checkout of ${remotes.join(", ") || "no GitHub repository"}, not of ${wanted.join(" or ")}.`;
    }

    return undefined;
}

/** Where the app looks for checkouts of a repository: the release source's, and the usual folders for code. */
function places(dataDir: string, repos: string[]): string[] {
    const home = homedir();
    const seed = readSource(dataDir)?.seed;
    const names = [...new Set(repos.map((each) => each.split("/").at(-1)!))];

    return [
        ...(seed === undefined ? [] : [seed]),
        ...names.flatMap((name) =>
            ["repo", "repos", "src", "code", "projects", "dev", "git", ""].map((under) =>
                join(home, under, name),
            ),
        ),
        ...repos.map((each) => join(dataDir, "repos", ...repoArgs(each).path.split("/"))),
    ];
}

/** The checkouts of the project's repository (or pi-talaria's own) this machine has, among `also` and the usual places. */
export async function findCheckouts(
    dataDir: string,
    repos: { repository: string; upstream?: string },
    also: readonly string[] = [],
): Promise<string[]> {
    const wanted = [repos.repository, repos.upstream].filter(
        (each): each is string => each !== undefined,
    );
    const found: string[] = [];

    for (const folder of new Set(
        [...also, ...places(dataDir, wanted)].map((each) => resolve(each)),
    )) {
        if ((await notACheckout(folder, repos)) === undefined) {
            found.push(folder);
        }
    }

    return found;
}

/** Where a clone goes when the person names no place: `~/repo/<name>`. */
export const defaultClonePlace = (repository: string): string =>
    join(homedir(), "repo", repository.split("/").at(-1)!);

/**
 * Clone the project's repository into `folder`, which must not be there yet. From a local checkout of it when this
 * machine has one (a full clone over a slow line takes long), then pointed at GitHub and fetched; else with `gh repo
 * clone`. A fork's clone gets pi-talaria's repository as `upstream`. Cloned beside its place and moved there when
 * complete, so a clone cut off midway is never taken for one.
 */
export async function cloneCheckout(
    gh: Gh,
    repos: { repository: string; upstream?: string },
    folder: string,
    seed: string | undefined,
): Promise<void> {
    if (!isAbsolute(folder)) {
        throw new Error(`${folder} is not an absolute path: give one, or ~/….`);
    }

    if (existsSync(folder)) {
        throw new Error(
            `${folder} is there already: bind it if it is a checkout, or pick another place.`,
        );
    }

    mkdirSync(dirname(folder), { recursive: true });
    const part = `${folder}~part-${randomUUID().slice(0, 8)}`;
    const long = { timeoutMs: CLONE_TIMEOUT_MS };

    try {
        if (seed !== undefined) {
            await git(dirname(folder), ["clone", "--quiet", seed, part], long);
            await git(part, ["remote", "set-url", "origin", httpsUrl(repos.repository)]);

            if (repos.upstream !== undefined) {
                await git(part, ["remote", "add", "upstream", httpsUrl(repos.upstream)]);
            }

            await git(part, ["fetch", "--quiet", "origin"], long);
            await git(part, ["remote", "set-head", "origin", "--auto"]);
            const head = (
                await git(part, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
            ).trim();

            await git(part, ["checkout", "--quiet", "-B", head.replace(/^origin\//, ""), head]);
        } else {
            await gh(["repo", "clone", repos.repository, part], undefined, CLONE_TIMEOUT_MS);
        }

        renameSync(part, folder);
    } catch (error) {
        rmSync(part, { recursive: true, force: true });

        throw new Error(
            `${repos.repository} could not be cloned into ${folder}: ${describe(error)}`,
        );
    }
}

/** Change a project's `project.json`, keeping what else it holds. */
export function updateProjectJson(
    folder: string,
    change: (file: Record<string, unknown>) => void,
): void {
    const path = join(folder, "project.json");
    let file: Record<string, unknown> = {};

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            file = parsed as Record<string, unknown>;
        }
    } catch {
        // A file that does not parse is written anew.
    }

    change(file);
    const part = `${path}.${randomUUID().slice(0, 8)}.tmp`;

    writeFileSync(part, `${JSON.stringify(file, null, 4)}\n`);
    renameSync(part, path);
}

/** The develop project's instructions file. */
export function developAgents(repos: { repository: string; upstream?: string }): string {
    const fork =
        repos.upstream === undefined
            ? ""
            : ` It is the person's fork of ${repos.upstream}: pull requests go from it to ${repos.upstream}.`;

    return `# ${DEVELOP_NAME}

This project develops pi-talaria, the app it runs in. Its repository is ${repos.repository}.${fork}

## Goal

Changes to pi-talaria, each tried on a dev instance before it reaches the running app.

## How work goes

1. The repository needs a local checkout first: \`project.json\` names it under \`checkout\` once it is bound (project_repo).
2. Each change is a thread in the checkout, on a branch of its own. The checkout's own \`AGENTS.md\` and \`docs/self-editing.md\` say how to edit pi-talaria safely.
3. The thread tries the change on a dev instance (the dev_instance tool, a sandbox on a copy of the data) and gives the person its address to try.
4. It opens a pull request; once the person agrees, it is merged into main.
5. The person updates the running app from Versions → Update (it goes back by itself if the new version fails).

## Notes

- Threads may work in this folder and in the folders that \`project.json\` lists under \`folders\`.
`;
}

/** What the coordinator is told when Develop made the project: its first message, before the person writes. */
export function developKickoff(
    repos: { repository: string; upstream?: string; forked: boolean },
    found: string[],
    place: string,
): { instructions: string; payload: string } {
    return {
        instructions: [
            `The person just pressed Develop in Versions, and the app made this project, ${JSON.stringify(DEVELOP_NAME)}, for developing pi-talaria.`,
            "Before any work, the project needs a local checkout of its repository. In a short welcome, say what this project is for and how work goes here (a thread per change, tried on a dev instance, merged, then Versions → Update), then ask the person with the ask tool which checkout to use:",
            "one choice per checkout found (bind it), one to let the app clone the repository to the suggested place, and Other for a path of their own (an existing checkout to bind, or a new place to clone to).",
            "When they answer, do it with project_repo (bind or clone). Do nothing with project_repo before they answer.",
        ].join(" "),
        payload: [
            `Repository: ${repos.repository}${repos.upstream === undefined ? "" : ` (a fork of ${repos.upstream}${repos.forked ? ", made now" : ""})`}`,
            `Checkouts found on this machine: ${found.length === 0 ? "none" : found.join(", ")}`,
            `Suggested place for a clone: ${place}`,
        ].join("\n"),
    };
}
