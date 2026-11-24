/**
 * Projects for pip / project / thread: each project is a folder in ~/pip/projects with one resident coordinator
 * session, which starts threads (linked sessions) for the work and hears their reports. PiP lists and creates them.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { arr, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web.
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { PROJECTS_PIP_EXTENSION } from "../pip.ts";
import { literal } from "../tool-schema.ts";

export type Project = {
    /** The folder's name under ~/pip/projects, which is also the id. */
    id: string;
    name: string;
    folder: string;
    /** The coordinator session's id, as in its address (`/s/12`). */
    coordinator: number;
    status: "active" | "archived";
    createdAt: number;
};

/** Every project, by id. Stored data: never rename the kind. */
export const ProjectsDoc = defineDoc<{ items: Record<string, Project> }>({
    kind: "x.talaria-projects.projects",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ items: {} }),
});

const MAX_NAME = 60;
const MAX_PURPOSE = 2000;
const MAX_FOLDERS = 20;

/** `~/pip`, or `PI_TALARIA_PIP_DIR` (tests use their own). */
export function pipRoot(): string {
    return process.env.PI_TALARIA_PIP_DIR ?? join(homedir(), "pip");
}

/** A project's name as one trimmed line, or an error. */
function nameOf(value: unknown): string {
    const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

    if (name === "" || [...name].length > MAX_NAME) {
        throw new Error(`A project's name is 1 to ${String(MAX_NAME)} characters.`);
    }

    if (/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name)) {
        throw new Error("A project's name has no control characters.");
    }

    return name;
}

/** The folder name for a project's name: letters and digits of any script, with `-` for the rest. */
export function slugOf(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    if (slug === "" || slug === "." || slug === "..") {
        throw new Error("Give the project a name with a letter or a digit in it.");
    }

    return slug;
}

/** The coordinator's instructions, in the project's AGENTS.md, which its session reads with every request. */
function agentsMd(name: string, purpose: string): string {
    return `# ${name}

${purpose === "" ? "（这个 project 的目标：和用户讨论后写在这里。）" : purpose}

## 你的角色

你是这个 project 的 coordinator：project 里唯一常驻的会话。用户在这里和你讨论这个 project；具体的工作交给 thread 去做。

- 一件具体的工作开一个 thread：用 team 工具的 start。thread 的文件夹（cwd）从 project.json 的 folders 里选；没有合适的就先问用户，并把用户给的文件夹写进 project.json。
- thread 看不到你的对话。第一条消息要写完整：目标、相关路径、已知情况、限制，以及用户说过的相关原话（原文照抄，不要只转述）。
- 每个 thread 的第一条消息末尾，原样附上下面的“thread 规则”。
- thread 跑完会把最后的回答自动发回给你：不要轮询，也不要催它汇报。收到后告诉用户结果，还需要用户决定的事要问清楚。
- 一个 thread 的事做完了，把它归档（team 工具的 archive）；之后需要可以再取消归档。

## thread 规则（原样附给每个 thread）

- 你是 project「${name}」的一个 thread，由 coordinator 开出，文件夹固定，不能换。
- 耗时长的命令一律放到后台（background 工具）或交给 subagent，保证 coordinator 的消息随时能进来。
- 不要再开 linked session；需要帮手就用 subagent。
- 最后一条回答按这个格式写：做了什么；结果（附路径或链接）；还需要谁决定什么。
`;
}

/** Make a project's folder and files; nothing that is there already is overwritten. */
export function scaffold(name: string, purpose: string, folders: string[]): string {
    const root = pipRoot();
    const folder = join(root, "projects", slugOf(name));

    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(join(folder, "memory"), { recursive: true });

    const agents = join(folder, "AGENTS.md");
    const json = join(folder, "project.json");

    if (!existsSync(agents)) {
        writeFileSync(agents, agentsMd(name, purpose));
    }

    if (!existsSync(json)) {
        writeFileSync(
            json,
            `${JSON.stringify({ name, purpose, folders, createdAt: new Date().toISOString() }, null, 4)}\n`,
        );
    }

    return folder;
}

function purposeOf(value: unknown): string {
    const purpose = typeof value === "string" ? value.trim() : "";

    if ([...purpose].length > MAX_PURPOSE) {
        throw new Error(`A project's purpose is at most ${String(MAX_PURPOSE)} characters.`);
    }

    return purpose;
}

function foldersOf(value: unknown): string[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > MAX_FOLDERS) {
        throw new Error(`Folders are a list of at most ${String(MAX_FOLDERS)} paths.`);
    }

    return value.map((each) => {
        const path = typeof each === "string" ? each.trim() : "";

        if (path === "" || !(path.startsWith("/") || path.startsWith("~/"))) {
            throw new Error("Each folder is an absolute or ~/ path.");
        }

        return path;
    });
}

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
const linkText = (text: string): string => text.replace(/[[\]\\]/g, "\\$&");

const PIP_GUIDE = `Projects: the person keeps their work in projects (in ~/pip/projects). Each project has one resident coordinator session, which starts threads for the work. Use the projects tool to list them, make one when the person asks, and archive or bring one back. Link a project as [its name](/s/COORDINATOR_ID), so it opens with a tap. To ask a project something, send its coordinator a message with session_send and wait for the report; to hand the person over, send the coordinator what it needs (the person's own words, quoted as they wrote them, then your summary) and give the person the link. Never start sessions inside a project's folder yourself: the coordinator starts its threads.`;

export default function createTalariaProjects(host: PocketHost, web?: ExtensionWeb) {
    mkdirSync(join(pipRoot(), "home"), { recursive: true });
    mkdirSync(join(pipRoot(), "projects"), { recursive: true });

    const projects = defineTool({
        name: "projects",
        description:
            "List the person's projects (most recently active first), make a new one with its coordinator session, or archive or bring one back. list needs nothing; create needs name, and takes purpose and folders (the folders its threads may work in); archive and reactivate need project (its id).",
        parameters: obj(
            {
                action: union([
                    literal("list"),
                    literal("create"),
                    literal("archive"),
                    literal("reactivate"),
                ]),
                name: opt(str({ description: "create: the project's name" })),
                purpose: opt(
                    str({ description: "create: what the project is for, in a few lines" }),
                ),
                folders: opt(
                    arr(str(), {
                        description:
                            "create: absolute or ~/ paths of folders its threads may work in",
                    }),
                ),
                project: opt(str({ description: "archive, reactivate: the project's id" })),
            },
            { open: true },
        ),
        // Safe to run again: the coordinator a create made is kept with the call.
        replay: "safe",
        execute: async (args, api, context) => {
            const all = async () => (await api.snapshot(ProjectsDoc, context))?.items ?? {};

            if (args.action === "list") {
                const items = Object.values(await all());

                if (items.length === 0) {
                    return reply("No projects yet.");
                }

                const seen = new Map(
                    [
                        ...host.pip.sessions(api.conversationId, { limit: 100 }).sessions,
                        ...host.pip.sessions(api.conversationId, { limit: 100, archived: true })
                            .sessions,
                    ].map((session) => [session.id, session]),
                );
                const lines = items
                    .map((project) => ({
                        project,
                        at: seen.get(project.coordinator)?.updatedAt ?? 0,
                    }))
                    .sort((a, b) => b.at - a.at)
                    .map(
                        ({ project, at }) =>
                            `${project.id}: [${linkText(project.name)}](/s/${String(project.coordinator)}) · ${project.status} · ${project.folder}${at === 0 ? "" : ` · last active ${new Date(at).toISOString()}`}`,
                    );

                return reply(lines.join("\n"));
            }

            if (args.action === "create") {
                const name = nameOf(args.name);
                const id = slugOf(name);
                const existing = (await all())[id];

                if (existing !== undefined) {
                    return reply(
                        `A project with that name exists: [${linkText(existing.name)}](/s/${String(existing.coordinator)}).`,
                    );
                }

                const folder = scaffold(name, purposeOf(args.purpose), foldersOf(args.folders));
                let coordinator = await api.memo<number>("talaria.coordinator", context);

                if (coordinator === undefined) {
                    const made = await host.pip.start(api.conversationId, { folder, title: name });

                    coordinator = await api.memo("talaria.coordinator", Number(made), context);
                }

                await api.commit(async (tx) => {
                    const doc = await tx.doc(ProjectsDoc);

                    doc.items[id] ??= {
                        id,
                        name,
                        folder,
                        coordinator,
                        status: "active",
                        createdAt: Date.now(),
                    };
                }, context);

                return reply(
                    `Made project ${id}: [${linkText(name)}](/s/${String(coordinator)}), in ${folder}.`,
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
                const item = (await tx.doc(ProjectsDoc)).items[id];

                if (item !== undefined) {
                    item.status = archived ? "archived" : "active";
                }
            }, context);

            return reply(
                `${archived ? "Archived" : "Brought back"} [${linkText(project.name)}](/s/${String(project.coordinator)}).`,
            );
        },
    });

    if (web !== undefined) {
        web.client("talaria-projects.js");

        // The projects, most recently active first, each with its coordinator's threads.
        web.route("GET", "projects", async (request: WebRequest) => {
            const doc = await request.snapshot(ProjectsDoc, request.context);
            const sessions = request.sessions();
            const byId = new Map(sessions.map((session) => [session.id, session]));

            return Object.values(doc?.items ?? {})
                .map((project) => {
                    const threads = sessions
                        .filter((session) => session.linkedFrom === project.coordinator)
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .map((session) => ({
                            id: session.id,
                            title: session.title,
                            cwd: session.cwd,
                            archived: session.archived,
                            updatedAt: session.updatedAt,
                        }));
                    const updatedAt = Math.max(
                        byId.get(project.coordinator)?.updatedAt ?? project.createdAt,
                        ...threads.map((thread) => thread.updatedAt),
                    );

                    return { ...project, updatedAt, threads };
                })
                .sort((a, b) => b.updatedAt - a.updatedAt);
        });

        // A new project from the page: its folder, then its coordinator.
        web.route("POST", "projects", async (request: WebRequest) => {
            let name: string;
            let folder: string;

            try {
                name = nameOf(request.body.name);
                folder = scaffold(
                    name,
                    purposeOf(request.body.purpose),
                    foldersOf(request.body.folders),
                );
            } catch (error) {
                throw web.error(400, (error as Error).message);
            }

            const id = slugOf(name);
            const existing = (await request.snapshot(ProjectsDoc, request.context))?.items[id];

            if (existing !== undefined) {
                throw web.error(409, "A project with that name exists.");
            }

            const { id: session } = await request.createSession({ cwd: folder, title: name });
            const project: Project = {
                id,
                name,
                folder,
                coordinator: Number(session),
                status: "active",
                createdAt: Date.now(),
            };

            await request.commit(async (tx) => {
                (await tx.doc(ProjectsDoc)).items[id] ??= project;
            });

            return project;
        });
    }

    return [
        defineExtension({ name: "talaria-projects" }),
        defineExtension({
            name: PROJECTS_PIP_EXTENSION,
            tools: [projects],
            sections: [section("talaria_projects", () => PIP_GUIDE)],
        }),
    ];
}
