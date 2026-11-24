/**
 * Projects: each has a resident coordinator session in its own folder under ~/pip/projects, which starts threads
 * (linked sessions) in the project's folders and gets their reports.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web.
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { literal } from "../tool-schema.ts";

/** One project, as the app lists it. Stored data: never rename a field or change what it means. */
export type ProjectRecord = {
    /** The project's folder name under `projects/`, and its id in routes. */
    id: string;
    name: string;
    /** The coordinator's folder: `<root>/projects/<id>`. */
    folder: string;
    /** The coordinator session's id. */
    coordinator: number;
    status: "active" | "archived";
    createdAt: number;
};

/** Every project, by id. Stored data: never rename the kind. */
const Projects = defineDoc<{ items: Record<string, ProjectRecord> }>({
    kind: "x.talaria-projects.projects",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ items: {} }),
});

/** What `project.json` in a project's folder holds. People and the coordinator edit it; the app reads it fresh. */
interface ProjectFile {
    name?: string;
    /** Folders that the project's threads may work in, besides the project's own folder. */
    folders?: string[];
}

const MAX_NAME = 80;
const MAX_FOLDERS = 20;
const MAX_ID = 48;

/** Where pip keeps its folders: `PI_TALARIA_PIP_DIR`, or `~/pip`. */
export function pipRoot(): string {
    const given = process.env.PI_TALARIA_PIP_DIR?.trim();

    return given ? resolve(expandHome(given)) : join(homedir(), "pip");
}

/** `~` and `~/…` as the home folder; other paths as they are. */
function expandHome(path: string): string {
    if (path === "~") {
        return homedir();
    }

    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Whether `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
    const rel = relative(folder, path);

    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A folder name for a project: lowercase letters, digits and `-`, from its name; "" when the name has none. */
export function projectId(name: string): string {
    return name
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_ID)
        .replace(/-+$/g, "");
}

/** The project whose folder is `cwd`, read from its `project.json`; undefined for any other folder. */
export function projectAt(
    cwd: string | undefined,
): { id: string; folder: string; file: ProjectFile } | undefined {
    if (cwd === undefined) {
        return undefined;
    }

    const projects = join(pipRoot(), "projects");
    const folder = resolve(cwd);
    const rel = relative(projects, folder);

    if (
        rel === "" ||
        rel.startsWith("..") ||
        isAbsolute(rel) ||
        rel.includes("/") ||
        rel.includes("\\")
    ) {
        return undefined;
    }

    const path = join(folder, "project.json");

    if (!existsSync(path)) {
        return undefined;
    }

    return { id: rel, folder, file: readProjectFile(path) };
}

/** The last good read of each `project.json`, by path and modification time: the prompt asks on each request. */
const files = new Map<string, { mtime: number; file: ProjectFile }>();

function readProjectFile(path: string): ProjectFile {
    let mtime = 0;

    try {
        mtime = statSync(path).mtimeMs;
    } catch {
        return {};
    }

    const kept = files.get(path);

    if (kept?.mtime === mtime) {
        return kept.file;
    }

    let file: ProjectFile = {};

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const { name, folders } = parsed as Record<string, unknown>;

            file = {
                ...(typeof name === "string" ? { name } : {}),
                ...(Array.isArray(folders)
                    ? {
                          folders: folders
                              .filter(
                                  (each): each is string =>
                                      typeof each === "string" && each.trim() !== "",
                              )
                              .slice(0, MAX_FOLDERS),
                      }
                    : {}),
            };
        }
    } catch {
        // A file that does not parse lists no folders; the coordinator can mend it.
    }

    files.set(path, { mtime, file });

    return file;
}

/** The folders a project's threads may work in: its own, and those `project.json` lists, as absolute paths. */
export function threadFolders(project: { folder: string; file: ProjectFile }): string[] {
    return [
        project.folder,
        ...(project.file.folders ?? []).map((each) =>
            resolve(project.folder, expandHome(each.trim())),
        ),
    ];
}

/** The project's instructions file as a new project starts it. The coordinator reads it on each request. */
function agentsTemplate(name: string): string {
    return `# ${name}

This folder is the home of the project "${name}". Its coordinator session works here.

## Goal

(What this project is for. Write it here, or ask the coordinator to.)

## Notes

- Threads may work in this folder and in the folders that \`project.json\` lists under \`folders\`.
`;
}

/** The rules a coordinator gets in its system prompt. */
function coordinatorRules(project: { id: string; folder: string; file: ProjectFile }): string {
    const name = project.file.name ?? project.id;
    const folders = threadFolders(project);

    return [
        `You are the coordinator of the project ${JSON.stringify(name)}. The person you work for spends most of their time with you: plan the work with them, keep track of what is decided, and answer for the project as a whole.`,
        `For a concrete piece of work (a change in a repository, a long job, research), start a thread with the project_thread tool: an ordinary session of its own, in one of the project's folders. A thread does not see your history: brief it fully (goal, folder, what is known, limits, what to report). When its run ends, its final answer comes back to you by itself: do not poll, and do not ask it to report. Start what you need, end your turn, and wait. Do short things yourself.`,
        `Threads may work in: ${folders.map((each) => JSON.stringify(each)).join(", ")}. To allow another folder, add it to "folders" in ${JSON.stringify(join(project.folder, "project.json"))} (the person decides which folders).`,
        `When a thread is done and its result is taken, resolve it (project_thread resolve). Reopen it to go on with the same work.`,
    ].join("\n");
}

/** The first lines of each thread's first message: where it belongs, and how to work and report. */
function threadBrief(name: string, folder: string, task: string): string {
    return [
        `You are a thread of the project ${JSON.stringify(name)}, started by its coordinator. You work in ${JSON.stringify(folder)} and nowhere else.`,
        `- Keep yourself free for the coordinator's messages: run long commands (builds, test suites, servers) with the background tool, or give long work to a subagent. Do not wait on them in the foreground.`,
        `- You cannot start other sessions. You may use subagents.`,
        `- Your final answer goes back to the coordinator by itself. Write it as a report: what you did, the result, and what someone still has to decide. Write in the language of the person the project is for.`,
        "",
        "Task:",
        task,
    ].join("\n");
}

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

export default function createTalariaProjects(host: PocketHost, web?: ExtensionWeb) {
    const linked = host.linkedSessions;
    const { text } = host;

    if (web !== undefined) {
        web.client("talaria-projects");

        // Every project, with when its coordinator last moved, newest first.
        web.route("GET", "projects", async (request) => {
            const doc = await request.snapshot(Projects, request.context);
            const sessions = new Map(
                (typeof request.sessions === "function" ? request.sessions() : []).map((each) => [
                    each.id,
                    each,
                ]),
            );
            const items = Object.values(doc?.items ?? {}).map((project) => {
                const session = sessions.get(project.coordinator);
                const file = projectAt(project.folder)?.file;

                return {
                    ...project,
                    name: file?.name ?? project.name,
                    folders: file?.folders ?? [],
                    lastActive: session?.updatedAt ?? project.createdAt,
                    missing: session === undefined,
                };
            });

            items.sort((a, b) => b.lastActive - a.lastActive);

            return { root: pipRoot(), projects: items };
        });

        // A new project: its folder, its files, and its coordinator session.
        web.route("POST", "projects", async (request) => {
            if (typeof request.createSession !== "function") {
                throw web.error(503, "Projects need a server restart before they can be made.");
            }

            const name =
                typeof request.body.name === "string"
                    ? request.body.name.trim().replace(/\s+/g, " ")
                    : "";

            if (
                name === "" ||
                [...name].length > MAX_NAME ||
                /[\p{Cc}\p{Bidi_Control}]/u.test(name)
            ) {
                throw web.error(
                    400,
                    `A project's name is 1 to ${MAX_NAME} characters, on one line.`,
                );
            }

            const given = request.body.folders;

            if (
                given !== undefined &&
                (!Array.isArray(given) ||
                    given.length > MAX_FOLDERS ||
                    !given.every((each) => typeof each === "string"))
            ) {
                throw web.error(400, `Folders are a list of up to ${MAX_FOLDERS} paths.`);
            }

            const folders = ((given ?? []) as string[]).map((each) => each.trim()).filter(Boolean);

            for (const each of folders) {
                const path = resolve(expandHome(each));

                if (
                    !isAbsolute(expandHome(each)) ||
                    !existsSync(path) ||
                    !statSync(path).isDirectory()
                ) {
                    throw web.error(
                        400,
                        `${each} is not a folder on this machine. Give an absolute path or ~/….`,
                    );
                }
            }

            const doc = await request.snapshot(Projects, request.context);
            const taken = new Set(Object.keys(doc?.items ?? {}));
            const projects = join(pipRoot(), "projects");
            const base = projectId(name) || "project";
            let id = base;

            for (let n = 2; taken.has(id) || existsSync(join(projects, id)); n++) {
                id = `${base}-${n}`;
            }

            const folder = join(projects, id);

            mkdirSync(folder, { recursive: true, mode: 0o700 });
            writeFileSync(
                join(folder, "project.json"),
                `${JSON.stringify({ name, folders }, null, 4)}\n`,
                {
                    flag: "wx",
                },
            );
            writeFileSync(join(folder, "AGENTS.md"), agentsTemplate(name), { flag: "wx" });

            const { id: coordinator } = await request.createSession({ cwd: folder, title: name });
            const record: ProjectRecord = {
                id,
                name,
                folder,
                coordinator,
                status: "active",
                createdAt: Date.now(),
            };

            await request.commit(async (tx) => {
                const state = await tx.doc(Projects);

                state.items[id] = record;
            });
            web.send("changed");

            return record;
        });
    }

    const actions = ["start", "list", "send", "resolve", "reopen"] as const;

    const thread = defineTool({
        name: "project_thread",
        description:
            "For a project's coordinator only: its threads, each a linked session in one of the project's folders. " +
            "start: folder, title, and a task that holds all the thread needs. list: the threads, by address. " +
            "send: a message to an address. resolve / reopen: archive a finished thread, or bring it back.",
        parameters: obj({
            action: union(actions.map((each) => literal(each))),
            folder: opt(
                str({
                    description: "start: one of the project's folders; left out: the project's own",
                }),
            ),
            title: opt(str({ description: "start: the thread's title" })),
            message: opt(str({ description: "start: the task; send: the message" })),
            to: opt(str({ description: "send, resolve, reopen: an address from list" })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const project = projectAt((await api.agent(context)).cwd);

            if (project === undefined) {
                throw new Error(
                    "project_thread works only in a project's coordinator session (a session in a folder under ~/pip/projects).",
                );
            }

            const key = `x.talaria-projects:${api.taskId}:${api.callId}`;
            const source = api.conversationId;

            if (args.action === "list") {
                const found = await linked.list(source);
                const line = (each: (typeof found)[number]) =>
                    each.title === undefined
                        ? `${each.address} · details hidden`
                        : `${each.address} · ${text.quoted(each.title)} · ${each.busy ? "working" : "idle"}${each.archived ? " · resolved" : ""} · ${text.quoted(each.cwd ?? "")}`;

                return reply(found.length === 0 ? "No threads yet." : found.map(line).join("\n"));
            }

            if (args.action === "start") {
                if (!args.message?.trim()) {
                    throw new Error("start needs the task as message.");
                }

                const allowed = threadFolders(project);
                const folder = args.folder?.trim()
                    ? resolve(project.folder, expandHome(args.folder.trim()))
                    : project.folder;

                if (!allowed.some((each) => within(folder, each))) {
                    throw new Error(
                        `${folder} is not one of this project's folders (${allowed.join(", ")}). Ask the person whether to add it to project.json; do not work around it.`,
                    );
                }

                const name = project.file.name ?? project.id;
                const { address } = await linked.start(
                    source,
                    {
                        title: args.title?.trim() || undefined,
                        message: threadBrief(name, folder, args.message.trim()),
                        cwd: folder,
                    },
                    key,
                );

                return reply(
                    `Started thread ${address} in ${folder}. Its report comes back by itself when its run ends: end your turn and wait; do not poll.`,
                );
            }

            if (args.to === undefined || args.to.trim() === "") {
                throw new Error(`${args.action} needs an address, from list.`);
            }

            if (args.action === "send") {
                if (!args.message?.trim()) {
                    throw new Error("send needs a message.");
                }

                await linked.send(source, { to: args.to, message: args.message }, key);

                return reply(
                    `Message taken by ${args.to}. Its answer comes back by itself: do not poll.`,
                );
            }

            const { archived } = await linked.archive(
                source,
                { to: args.to, archived: args.action === "resolve" },
                key,
            );

            return reply(
                archived ? `Thread ${args.to} is resolved.` : `Thread ${args.to} is open again.`,
            );
        },
    });

    return defineExtension({
        name: "talaria-projects",
        tools: [thread],
        sections: [
            section("talaria-project", ({ agent }) => {
                const project = projectAt(agent.cwd);

                return project === undefined ? undefined : coordinatorRules(project);
            }),
        ],
    });
}
