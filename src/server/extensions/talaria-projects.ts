/**
 * Projects: each has a resident coordinator session in its own folder under ~/pip/projects, which starts threads
 * (linked sessions) in the project's folders and gets their reports.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { arr, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web.
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { PROJECTS_PIP_EXTENSION } from "../pip.ts";
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
export const Projects = defineDoc<{ items: Record<string, ProjectRecord> }>({
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

/** A folder name for a project: letters and digits of any script and `-`, from its name; "" when it has none. */
export function projectId(name: string): string {
    return name
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
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

/** Why a project's name or folders are refused; undefined when they are fine. */
function refusal(name: string, folders: string[]): string | undefined {
    if (name === "" || [...name].length > MAX_NAME || /[\p{Cc}\p{Bidi_Control}]/u.test(name)) {
        return `A project's name is 1 to ${MAX_NAME} characters, on one line.`;
    }

    if (folders.length > MAX_FOLDERS) {
        return `Folders are a list of up to ${MAX_FOLDERS} paths.`;
    }

    for (const each of folders) {
        const path = resolve(expandHome(each));

        if (!isAbsolute(expandHome(each)) || !existsSync(path) || !statSync(path).isDirectory()) {
            return `${each} is not a folder on this machine. Give an absolute path or ~/….`;
        }
    }

    return undefined;
}

/** A new project's folder and files, under an id no project has yet: `name`, or `name-2`, and so on. */
function makeFolder(name: string, folders: string[], taken: ReadonlySet<string>) {
    const projects = join(pipRoot(), "projects");
    const base = projectId(name) || "project";
    let id = base;

    for (let n = 2; taken.has(id) || existsSync(join(projects, id)); n++) {
        id = `${base}-${n}`;
    }

    const folder = join(projects, id);

    mkdirSync(join(pipRoot(), "home"), { recursive: true });
    mkdirSync(join(folder, "memory"), { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, "project.json"), `${JSON.stringify({ name, folders }, null, 4)}\n`, {
        flag: "wx",
    });
    writeFileSync(join(folder, "AGENTS.md"), agentsTemplate(name), { flag: "wx" });

    return { id, folder };
}

const PIP_GUIDE = `Projects: the person keeps their work in projects (folders under ~/pip/projects). Each has one resident coordinator session, which starts threads for the work. Use the projects tool to list them, make one when the person asks, and archive or bring one back. Link a project as [its name](/s/COORDINATOR_ID), so it opens with a tap. To ask a project something, send its coordinator a message with session_send and wait for the report. To hand the person over, send the coordinator what it needs (the person's own words, quoted as they wrote them, then your summary) and give the person the link. Do not start sessions in a project's folders yourself: its coordinator starts its threads.`;

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
const linkText = (text: string): string => text.replace(/[[\]\\]/g, "\\$&");

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
                const threads = [...sessions.values()]
                    .filter((each) => each.linkedFrom === project.coordinator)
                    .sort((x, y) => y.updatedAt - x.updatedAt)
                    .map((each) => ({
                        id: each.id,
                        title: each.title,
                        cwd: each.cwd,
                        resolved: each.archived,
                        lastActive: each.updatedAt,
                    }));

                return {
                    ...project,
                    threads,
                    name: file?.name ?? project.name,
                    folders: file?.folders ?? [],
                    lastActive: Math.max(
                        session?.updatedAt ?? project.createdAt,
                        ...threads.map((each) => each.lastActive),
                    ),
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
            const given = request.body.folders;

            if (
                given !== undefined &&
                (!Array.isArray(given) || !given.every((each) => typeof each === "string"))
            ) {
                throw web.error(400, `Folders are a list of up to ${MAX_FOLDERS} paths.`);
            }

            const folders = ((given ?? []) as string[]).map((each) => each.trim()).filter(Boolean);
            const refused = refusal(name, folders);

            if (refused !== undefined) {
                throw web.error(400, refused);
            }

            const doc = await request.snapshot(Projects, request.context);
            const { id, folder } = makeFolder(
                name,
                folders,
                new Set(Object.keys(doc?.items ?? {})),
            );

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

    const projects = defineTool({
        name: "projects",
        description:
            "The person's projects, most recently active first; make a new one with its coordinator session; archive one or bring it back. list needs nothing. create needs name, and takes folders (existing folders its threads may work in, besides its own). archive and reactivate need project (its id, from list).",
        parameters: obj(
            {
                action: union([
                    literal("list"),
                    literal("create"),
                    literal("archive"),
                    literal("reactivate"),
                ]),
                name: opt(str({ description: "create: the project's name" })),
                folders: opt(
                    arr(str(), {
                        description: "create: absolute or ~/ paths of folders its threads may use",
                    }),
                ),
                project: opt(str({ description: "archive, reactivate: the project's id" })),
            },
            { open: true },
        ),
        // Safe to run again: what a create made is kept with the call.
        replay: "safe",
        execute: async (args, api, context) => {
            const all = async () => (await api.snapshot(Projects, context))?.items ?? {};

            if (args.action === "list") {
                const items = Object.values(await all());

                if (items.length === 0) {
                    return reply("No projects yet.");
                }

                const seen = new Map(
                    [false, true]
                        .flatMap(
                            (archived) =>
                                host.pip.sessions(api.conversationId, { limit: 100, archived })
                                    .sessions,
                        )
                        .map((session) => [session.id, session.updatedAt]),
                );

                return reply(
                    items
                        .map((project) => ({ project, at: seen.get(project.coordinator) ?? 0 }))
                        .sort((a, b) => b.at - a.at)
                        .map(
                            ({ project, at }) =>
                                `${project.id}: [${linkText(projectAt(project.folder)?.file.name ?? project.name)}](/s/${String(project.coordinator)}) · ${project.status} · ${project.folder}${at === 0 ? "" : ` · last active ${new Date(at).toISOString()}`}`,
                        )
                        .join("\n"),
                );
            }

            if (args.action === "create") {
                const name = (args.name ?? "").trim().replace(/\s+/g, " ");
                const folders = (args.folders ?? []).map((each) => each.trim()).filter(Boolean);
                const refused = refusal(name, folders);

                if (refused !== undefined) {
                    throw new Error(refused);
                }

                // A replay finds the folder and the coordinator the first run made.
                let made = await api.memo<{ id: string; folder: string }>(
                    "talaria.project",
                    context,
                );

                if (made === undefined) {
                    made = await api.memo(
                        "talaria.project",
                        makeFolder(name, folders, new Set(Object.keys(await all()))),
                        context,
                    );
                }

                let coordinator = await api.memo<number>("talaria.coordinator", context);

                if (coordinator === undefined) {
                    const started = await host.pip.start(api.conversationId, {
                        folder: made.folder,
                        title: name,
                    });

                    coordinator = await api.memo("talaria.coordinator", Number(started), context);
                }

                const record: ProjectRecord = {
                    id: made.id,
                    name,
                    folder: made.folder,
                    coordinator,
                    status: "active",
                    createdAt: Date.now(),
                };

                await api.commit(async (tx) => {
                    (await tx.doc(Projects)).items[record.id] ??= record;
                }, context);
                web?.send("changed");

                return reply(
                    `Made project ${record.id}: [${linkText(name)}](/s/${String(coordinator)}), in ${record.folder}.`,
                );
            }

            const id = args.project ?? "";
            const project = (await all())[id];

            if (project === undefined) {
                throw new Error(`There is no project ${JSON.stringify(id)}: list them first.`);
            }

            const archived = args.action === "archive";

            await host.pip.archive(api.conversationId, project.coordinator, archived);
            await api.commit(async (tx) => {
                const item = (await tx.doc(Projects)).items[id];

                if (item !== undefined) {
                    item.status = archived ? "archived" : "active";
                }
            }, context);
            web?.send("changed");

            return reply(
                `${archived ? "Archived" : "Brought back"} [${linkText(project.name)}](/s/${String(project.coordinator)}).`,
            );
        },
    });

    return [
        defineExtension({
            name: PROJECTS_PIP_EXTENSION,
            tools: [projects],
            sections: [section("talaria_projects", () => PIP_GUIDE)],
        }),
        defineExtension({
            name: "talaria-projects",
            tools: [thread],
            sections: [
                section("talaria-project", ({ agent }) => {
                    const project = projectAt(agent.cwd);

                    return project === undefined ? undefined : coordinatorRules(project);
                }),
            ],
        }),
    ];
}
