// Projects' browser module. At the top of the session list: PiP and the projects, newest activity first, each with
// where it stands and what waits on the person; the sessions of projects leave the list below (a filter turns that
// off). Beside a project's coordinator or thread: the project, its threads by state, and its memory. A page lists every
// project and makes new ones. After a handoff from PiP, the tab that showed PiP opens the project. It uses only
// `pocket`.
export const pocketApi = 2;

/** Lucide's folder-kanban icon. */
const GEAR_PATH =
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z";

const PROJECTS_PATH =
    "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z M8 10v4 M12 10v2 M16 10v6";

/** Thread groups in the order they need the person: what waits on them first. Resolved ones fold away. */
const GROUPS = [
    ["waiting", "Waiting on you"],
    ["failed", "Failed"],
    ["working", "Working"],
    ["pr-closed", "PR closed, not merged"],
    ["review", "Ready for review"],
    ["pr-open", "PR open"],
    ["idle", "Idle"],
];

/** How long ago `at` was, in a few words. */
function ago(at) {
    const minutes = Math.round((Date.now() - at) / 60_000);

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export default function setup(pocket) {
    const { html, useEffect, useState, Loader, Icon } = pocket;

    // ─── What the server says of the projects, shared by every view of this tab ───

    let latest = null;
    let failure = null;
    let asking = null;
    const hearers = new Set();
    /** The sessions of projects (coordinators and threads), which the session list leaves out. */
    let projectSessions = new Set();
    /** The session list's filter, and whether it hides the projects' sessions now (on until turned off). */
    let filter = null;
    let hiding = true;
    const keeps = (session) => !projectSessions.has(session.id);

    /** Whether the server said the projects changed while a read was on its way: then read once more after it. */
    let again = false;
    /** The projects the sidebar lists: not archived, and with their folder there. */
    const active = (data) =>
        (data?.projects ?? []).filter(
            (project) => project.status !== "archived" && !project.missing,
        );

    /** Read the projects once, and tell every view. */
    const read = async () => {
        try {
            const data = await pocket.api("projects");

            latest = data;
            failure = null;
            // Only the sidebar's projects: the sessions of an archived project stay in the list.
            projectSessions = new Set(
                active(data).flatMap((project) => [
                    project.coordinator,
                    ...project.threads.map((each) => each.id),
                ]),
            );
            // New functions: the list asks again which sessions it keeps, and their chips.
            filter?.update({ match: hiding ? (session) => keeps(session) : null });
            chips?.update({ chips: (session) => chipsOf(session) });
        } catch (error) {
            failure = error.message;
        }

        for (const hear of hearers) {
            hear({ data: latest, failure });
        }
    };

    /** Read the projects; a change said during a read reads again after it, and the promise waits for that too. */
    const refresh = () => {
        if (asking !== null) {
            again = true;

            return asking;
        }

        asking = (async () => {
            do {
                again = false;
                await read();
            } while (again);

            asking = null;
        })();

        return asking;
    };

    /** The projects as the server last said, and whether it failed; asks again when the server says they changed. */
    function useProjects() {
        const [now, setNow] = useState({ data: latest, failure });

        useEffect(() => {
            hearers.add(setNow);

            if (latest === null) {
                void refresh();
            }

            return () => hearers.delete(setNow);
        }, []);

        return now;
    }

    pocket.on("changed", () => void refresh());

    /** The session this tab shows, kept current. */
    function useShown() {
        const [shown, setShown] = useState(pocket.conversationId());

        useEffect(() => pocket.onConversation(setShown), []);

        return shown;
    }

    /** The project a session belongs to: as its coordinator, or as one of its threads. */
    const projectOf = (data, id) =>
        data?.projects.find(
            (project) =>
                project.coordinator === id || project.threads.some((each) => each.id === id),
        );

    /** How many of a project's threads are in each state. */
    const countsOf = (project) => {
        const counts = {};

        for (const each of project.threads) {
            counts[each.state] = (counts[each.state] ?? 0) + 1;
        }

        return counts;
    };

    // PiP handed a topic over to a project: the tab that shows that PiP opens the project's coordinator.
    pocket.on("open", (data) => {
        if (
            Number.isSafeInteger(data?.id) &&
            data.id > 0 &&
            data.from !== undefined &&
            Number(pocket.conversationId()) === data.from
        ) {
            pocket.openConversation(data.id);
        }
    });

    /** The form for a new project: a name, and the folders its threads may work in, one a line. */
    function NewProject({ onMade }) {
        const [name, setName] = useState("");
        const [folders, setFolders] = useState("");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);

        const make = async (event) => {
            event.preventDefault();

            if (name.trim() === "" || busy) {
                return;
            }

            setBusy(true);
            setError(null);

            try {
                const made = await pocket.api("projects", {
                    name,
                    folders: folders
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                });

                setName("");
                setFolders("");
                onMade(made);
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<form
            class="talaria-new"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            onSubmit=${make}
        >
            <h3>New project</h3>
            <input
                value=${name}
                name="talaria-project"
                placeholder="Project name"
                maxlength="80"
                autocomplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                onInput=${(event) => setName(event.currentTarget.value)}
            />
            <textarea
                rows="2"
                value=${folders}
                placeholder="Folders for threads, one a line (optional), e.g. ~/repo/app"
                autocapitalize="none"
                autocomplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                spellcheck=${false}
                onInput=${(event) => setFolders(event.currentTarget.value)}
            ></textarea>
            ${error && html`<div class="error-box">${error}</div>`}
            <div class="sheet-actions">
                <button type="submit" class="button primary" disabled=${busy || name.trim() === ""}>
                    ${busy ? "Making…" : "Make project"}
                </button>
            </div>
        </form>`;
    }

    /**
     * A level's memory files (`home`: the person's; else a project's id), folded until opened: tap one to read and change
     * it. A save replaces the version shown, so an agent's newer write is never lost unseen.
     */
    function Memory({ level, title }) {
        const [open, setOpen] = useState(false);
        const [files, setFiles] = useState(null);
        const [file, setFile] = useState(null);
        const [draft, setDraft] = useState("");
        const [newName, setNewName] = useState("");
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const base = `memory/${encodeURIComponent(level)}`;

        const load = async () => {
            try {
                setFiles((await pocket.api(base)).files);
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        };

        useEffect(() => {
            if (!open) {
                return undefined;
            }

            void load();

            return pocket.on("changed", () => void load());
        }, [open]);

        const pick = async (name) => {
            setError(null);

            try {
                const found = await pocket.api(`${base}/${encodeURIComponent(name)}`);

                setFile({ name, version: found.version });
                setDraft(found.text);
            } catch (failure) {
                setError(failure.message);
            }
        };

        const save = async (remove = false) => {
            setBusy(true);
            setError(null);

            try {
                const done = await pocket.api(
                    `${base}/${encodeURIComponent(file.name)}`,
                    remove
                        ? { delete: true, version: file.version }
                        : { text: draft, version: file.version },
                );

                setFile(remove ? null : { name: file.name, version: done.version });
                await load();
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        const make = (event) => {
            event.preventDefault();

            const name = newName.trim().replace(/(\.md)?$/i, ".md");

            if (name !== ".md") {
                setFile({ name, version: "new" });
                setDraft("");
                setNewName("");
            }
        };

        return html`<div class="talaria-memory">
            <button
                type="button"
                class="talaria-group talaria-toggle"
                aria-expanded=${open}
                onClick=${() => setOpen(!open)}
            >
                ${open ? "Hide" : "Show"} ${title}
            </button>
            ${
                open &&
                html`<div class="talaria-memory-body">
                    ${error && html`<div class="error-box">${error}</div>`}
                    ${
                        files === null
                            ? html`<${Loader} label="Reading the memory" />`
                            : files.length === 0
                              ? html`<p class="muted small">No memory files yet.</p>`
                              : files.map(
                                    (each) =>
                                        html`<button
                                            type="button"
                                            class=${`list-item talaria-thread${file?.name === each.name ? " selected" : ""}`}
                                            onClick=${() => pick(each.name)}
                                        >
                                            <span class="grow">
                                                <span class="mono">${each.name}</span>
                                                <span class="muted small"
                                                    >${each.bytes} bytes · ${ago(each.at)}</span
                                                >
                                            </span>
                                        </button>`,
                                )
                    }
                    ${
                        file &&
                        html`<div class="talaria-memory-file">
                            <div class="mono small">${file.name}</div>
                            <textarea
                                rows="10"
                                value=${draft}
                                spellcheck=${false}
                                autocomplete="off"
                                data-1p-ignore
                                data-lpignore="true"
                                data-form-type="other"
                                onInput=${(event) => setDraft(event.currentTarget.value)}
                            ></textarea>
                            <div class="sheet-actions">
                                ${
                                    file.version !== "new" &&
                                    html`<button
                                        type="button"
                                        class="button"
                                        disabled=${busy}
                                        onClick=${() => save(true)}
                                    >
                                        Delete
                                    </button>`
                                }
                                <button
                                    type="button"
                                    class="button primary"
                                    disabled=${busy || draft.trim() === ""}
                                    onClick=${() => save()}
                                >
                                    ${busy ? "Saving…" : "Save"}
                                </button>
                            </div>
                        </div>`
                    }
                    <form
                        class="talaria-memory-new"
                        autocomplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        data-form-type="other"
                        onSubmit=${make}
                    >
                        <input
                            value=${newName}
                            placeholder="New file, e.g. decisions.md"
                            autocomplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                            onInput=${(event) => setNewName(event.currentTarget.value)}
                        />
                        <button type="submit" class="button" disabled=${newName.trim() === ""}>
                            New
                        </button>
                    </form>
                </div>`
            }
        </div>`;
    }

    /** The page: every project, then the form. A tap on a project opens its coordinator. */
    function Projects({ close }) {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);

        const load = async () => {
            try {
                setData(await pocket.api("projects"));
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        };

        useEffect(() => {
            void load();

            return pocket.on("changed", () => void load());
        }, []);

        const open = (project) => {
            close?.();
            pocket.openConversation(project.coordinator);
        };

        if (error && !data) {
            return html`<div class="error-box">${error}</div>
                <button class="button" onClick=${load}>Try again</button>`;
        }

        if (!data) {
            return html`<${Loader} label="Reading the projects" />`;
        }

        return html`<div class="talaria-projects">
            ${
                data.projects.length === 0
                    ? html`<p class="muted">
                          No projects yet. Each project gets a coordinator session in
                          <span class="mono">${data.root}/projects/</span>.
                      </p>`
                    : html`<div class="sheet-list">
                          ${data.projects.map(
                              (project) => html`<${Project} project=${project} open=${open} />`,
                          )}
                      </div>`
            }
            <${NewProject} onMade=${(made) => open(made)} />
            <${Memory} level="home" title="your memory (kept by PiP)" />
        </div>`;
    }

    /** One project: its button, which opens the coordinator, then its threads by state; resolved ones folded away. */
    function Project({ project, open, current = null }) {
        const [showResolved, setShowResolved] = useState(false);
        const threads = project.threads ?? [];
        const stateOf = (each) => each.state ?? (each.resolved ? "resolved" : "idle");
        const resolved = threads.filter((each) => stateOf(each) === "resolved");
        const row = (each) =>
            html`<button
                type="button"
                class=${`list-item talaria-thread ${current === each.id ? "selected" : ""}`}
                aria-current=${current === each.id ? "true" : undefined}
                onClick=${() => open({ coordinator: each.id })}
            >
                <span class="grow">
                    <span class="talaria-thread-title">${each.title}</span>
                    <span class="muted small"
                        >${ago(each.lastActive)}${each.note ? ` · ${each.note}` : ""}</span
                    >
                </span>
            </button>`;

        return html`<button
                type="button"
                class=${`list-item ${current === project.coordinator ? "selected" : ""}`}
                aria-current=${current === project.coordinator ? "true" : undefined}
                disabled=${project.missing}
                onClick=${() => open(project)}
            >
                <span class="grow">
                    <span class="talaria-name">${project.name}</span>
                    <span class="muted small">
                        ${
                            project.missing
                                ? "Its coordinator session is gone"
                                : ago(project.lastActive)
                        }
                        ${project.status === "archived" ? " · archived" : ""}
                    </span>
                </span>
            </button>
            ${GROUPS.map(([state, label]) => {
                const group = threads.filter((each) => stateOf(each) === state);

                return group.length === 0
                    ? null
                    : html`<div class=${`talaria-group talaria-${state}`}>${label}</div>
                          ${group.map(row)}`;
            })}
            ${
                resolved.length === 0
                    ? null
                    : html`<button
                              type="button"
                              class="talaria-group talaria-toggle"
                              aria-expanded=${showResolved}
                              onClick=${() => setShowResolved(!showResolved)}
                          >
                              ${showResolved ? "Hide" : "Show"} ${resolved.length} resolved
                          </button>
                          ${showResolved ? resolved.map(row) : null}`
            }
            <${Memory} level=${project.id} title="project memory" />`;
    }

    /** What a project's row says of its threads: what waits on the person first. */
    function Counts({ project }) {
        const counts = countsOf(project);
        const asks = (counts.waiting ?? 0) + (counts.failed ?? 0);

        return html`${
            asks > 0 &&
            html`<span class="talaria-count talaria-ask" title="Threads waiting on you, or failed"
                >${asks}</span
            >`
        }${
            (counts.review ?? 0) > 0 &&
            html`<span class="talaria-count talaria-ready" title="Threads ready for review"
                >${counts.review}</span
            >`
        }${
            (counts.working ?? 0) > 0 &&
            html`<span
                class="talaria-working-dot"
                title="Threads at work"
                aria-label="At work"
            ></span>`
        }`;
    }

    /** The top of the session list: PiP, then each active project; a tap opens it. */
    function ProjectsNav() {
        const { data, failure: failed } = useProjects();
        const shown = useShown();
        const current = projectOf(data, shown);
        const projects = active(data);

        return html`<nav class="talaria-nav" aria-label="PiP and projects">
            <button
                type="button"
                class="talaria-nav-row talaria-nav-pip"
                onClick=${() => pocket.pip?.open?.()}
            >
                <${Icon} name="pip" size=${16} />
                <span class="talaria-nav-name">PiP</span>
            </button>
            <div class="talaria-nav-head">
                <span>Projects</span>
                <button
                    type="button"
                    class="talaria-nav-all"
                    title="All projects, and a new one"
                    aria-label="All projects, and a new one"
                    onClick=${() => pocket.openPage("projects")}
                >
                    <${Icon} name="plus" size=${14} />
                </button>
            </div>
            ${failed && !data && html`<div class="muted small">${failed}</div>`}
            ${
                data &&
                projects.length === 0 &&
                html`<button
                    type="button"
                    class="talaria-nav-row muted"
                    onClick=${() => pocket.openPage("projects")}
                >
                    Make a project
                </button>`
            }
            ${projects.map(
                (project) =>
                    html`<button
                        key=${project.id}
                        type="button"
                        class=${`talaria-nav-row ${current?.id === project.id ? "on" : ""}`}
                        aria-current=${current?.id === project.id ? "true" : undefined}
                        title=${project.summary ?? project.name}
                        onClick=${() => pocket.openConversation(project.coordinator)}
                    >
                        <${Icon} path=${PROJECTS_PATH} size=${15} />
                        <span class="talaria-nav-text">
                            <span class="talaria-nav-name">${project.name}</span>
                            ${
                                project.summary &&
                                html`<span class="talaria-nav-summary">${project.summary}</span>`
                            }
                        </span>
                        <${Counts} project=${project} />
                    </button>`,
            )}
        </nav>`;
    }

    // ─── The thread the Threads panel shows, of this tab ───

    /** `{ thread, helper? }`: a thread of the project, or one of its helpers under it; null for the list. */
    let viewing = null;
    const viewers = new Set();

    const view = (next) => {
        viewing = next;

        for (const hear of viewers) {
            hear(next);
        }
    };

    function useViewing() {
        const [now, setNow] = useState(viewing);

        useEffect(() => {
            viewers.add(setNow);

            return () => viewers.delete(setNow);
        }, []);

        return now;
    }

    /**
     * A thread in the Threads panel, as Claude's projects show one: a head with Back, its title, a done check that
     * resolves it, a button that opens it in full view, and a ⋯ menu (reopen it, its helpers; a helper has none); then
     * the thread itself, in a frame of the app (`?frame=thread`): its conversation, and a box to steer it.
     */
    function ThreadView({ thread, helper }) {
        const [menu, setMenu] = useState(false);
        const [busy, setBusy] = useState(false);
        const shown = helper ?? thread;
        const helpers = thread.helpers ?? [];
        const back = () => view(helper ? { thread: thread.id } : null);

        const archive = async (archived) => {
            setBusy(true);
            setMenu(false);

            try {
                await pocket.archiveConversation(thread.id, archived);
                await refresh();

                if (archived) {
                    view(null);
                }
            } catch (error) {
                pocket.notify("error", error.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<div class="talaria-thread-view">
            <div class="talaria-thread-head">
                <button
                    type="button"
                    class="icon-button"
                    aria-label=${helper ? `Back to ${thread.title}` : "Back to the threads"}
                    title="Back"
                    onClick=${back}
                >
                    <${Icon} name="back" size=${18} />
                </button>
                <span class="talaria-thread-name" title=${shown.title}>
                    ${helper && html`<span class="muted">${thread.title} › </span>`}${shown.title}
                </span>
                ${
                    !helper &&
                    !thread.resolved &&
                    html`<button
                        type="button"
                        class="icon-button talaria-done"
                        aria-label="Done: resolve this thread"
                        title="Done: resolve this thread"
                        disabled=${busy}
                        onClick=${() => void archive(true)}
                    >
                        <${Icon} name="check" size=${18} />
                    </button>`
                }
                <button
                    type="button"
                    class="icon-button talaria-full"
                    aria-label="Open in full view"
                    title="Open in full view"
                    onClick=${() => {
                        setMenu(false);
                        pocket.openConversation(shown.id);
                    }}
                >
                    <${Icon} name="fit" size=${18} />
                </button>
                ${
                    !helper &&
                    html`<button
                        type="button"
                        class=${`icon-button ${menu ? "on" : ""}`}
                        aria-label="More"
                        title="More"
                        aria-haspopup="menu"
                        aria-expanded=${menu}
                        onClick=${() => setMenu(!menu)}
                    >
                        <${Icon} name="more" size=${18} />
                    </button>`
                }
                ${
                    menu &&
                    !helper &&
                    html`<div class="talaria-menu" role="menu">
                        ${
                            !helper &&
                            thread.resolved &&
                            html`<button
                                type="button"
                                role="menuitem"
                                disabled=${busy}
                                onClick=${() => void archive(false)}
                            >
                                Reopen this thread
                            </button>`
                        }
                        ${
                            !helper &&
                            html`<div class="talaria-menu-head">Helpers and subagents</div>
                                ${
                                    helpers.length === 0
                                        ? html`<div class="talaria-menu-note muted small">
                                              No helpers yet. Its subagents show in its
                                              conversation.
                                          </div>`
                                        : helpers.map(
                                              (each) =>
                                                  html`<button
                                                      key=${each.id}
                                                      type="button"
                                                      role="menuitem"
                                                      onClick=${() => {
                                                          setMenu(false);
                                                          view({
                                                              thread: thread.id,
                                                              helper: each.id,
                                                          });
                                                      }}
                                                  >
                                                      ${each.title ?? "Helper"}
                                                      <span class="muted small">
                                                          ${each.resolved ? "archived" : each.busy ? "working" : ""}
                                                      </span>
                                                  </button>`,
                                          )
                                }`
                        }
                    </div>`
                }
            </div>
            <iframe
                key=${shown.id}
                class="talaria-thread-frame"
                src=${`/s/${shown.id}?frame=thread`}
                title=${shown.title ?? "Thread"}
            ></iframe>
        </div>`;
    }

    /** The project settings sheet, from the top bar of a project's coordinator (the owner's): its models. */
    function ProjectSettings() {
        const { data, failure: failed } = useProjects();
        const shown = useShown();
        const project = data?.projects.find((each) => each.coordinator === shown);

        if (data === null) {
            return failed
                ? html`<div class="error-box">${failed}</div>`
                : html`<${Loader} label="Reading the project" />`;
        }

        if (project === undefined) {
            return html`<p class="muted">Open a project's coordinator to change its settings.</p>`;
        }

        return html`<div class="talaria-settings">
            <h3 class="talaria-group">Models of ${project.name}</h3>
            <${ModelSettings} key=${project.id} project=${project} />
        </div>`;
    }

    /**
     * A project's models: the coordinator's model and thinking, and the default for new threads. "As now" leaves one
     * unset: the coordinator keeps its own, and threads start on the coordinator's.
     */
    function ModelSettings({ project }) {
        const [models, setModels] = useState(null);
        const [draft, setDraft] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [saved, setSaved] = useState(false);

        useEffect(() => {
            setDraft({
                coordinator: project.models?.coordinator ?? null,
                threads: project.models?.threads ?? null,
            });
            pocket
                .api("models")
                .then((data) => setModels(data.models))
                .catch((failure) => setError(failure.message));
        }, [project.id]);

        const levelsOf = (spec) => models?.find((each) => each.spec === spec)?.levels ?? [];

        const change = (role, patch) => {
            setSaved(false);
            setDraft((now) => {
                const next = patch === null ? null : { ...(now[role] ?? {}), ...patch };

                // A level the new model lacks is dropped: the model's own default then.
                if (next?.thinking && !levelsOf(next.model).includes(next.thinking)) {
                    delete next.thinking;
                }

                return { ...now, [role]: next };
            });
        };

        const save = async () => {
            setBusy(true);
            setError(null);

            try {
                await pocket.api(`projects/${encodeURIComponent(project.id)}/models`, draft);
                setSaved(true);
                void refresh();
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        const row = (role, label, unset) => {
            const choice = draft?.[role] ?? null;
            const known = choice === null || models?.some((each) => each.spec === choice.model);

            return html`<div class="talaria-model-row">
                <label class="small" for=${`talaria-${role}-model`}>${label}</label>
                <select
                    id=${`talaria-${role}-model`}
                    value=${choice?.model ?? ""}
                    onChange=${(event) =>
                        change(
                            role,
                            event.currentTarget.value === ""
                                ? null
                                : { model: event.currentTarget.value },
                        )}
                >
                    <option value="">${unset}</option>
                    ${!known && html`<option value=${choice.model}>${choice.model}</option>`}
                    ${(models ?? []).map(
                        (each) =>
                            html`<option key=${each.spec} value=${each.spec}>
                                ${each.name} (${each.spec})
                            </option>`,
                    )}
                </select>
                <select
                    aria-label=${`${label}: thinking`}
                    disabled=${choice === null}
                    value=${choice?.thinking ?? ""}
                    onChange=${(event) =>
                        change(role, { thinking: event.currentTarget.value || undefined })}
                >
                    <option value="">Thinking: model's default</option>
                    ${(choice === null ? [] : levelsOf(choice.model)).map(
                        (level) =>
                            html`<option key=${level} value=${level}>Thinking: ${level}</option>`,
                    )}
                </select>
            </div>`;
        };

        return html`<div class="talaria-models">
            ${error && html`<div class="error-box">${error}</div>`}
            ${
                models === null || draft === null
                    ? html`<${Loader} label="Reading the models" />`
                    : html`${row("coordinator", "Coordinator", "As it runs now")}
                          ${row("threads", "New threads", "Same as the coordinator")}
                          <p class="muted small">
                              The coordinator can name another model for one thread. A thread's own
                              model picker still works.
                          </p>
                          <div class="sheet-actions">
                              ${saved && html`<span class="muted small">Saved</span>`}
                              <button
                                  type="button"
                                  class="button primary"
                                  disabled=${busy}
                                  onClick=${save}
                              >
                                  ${busy ? "Saving…" : "Save"}
                              </button>
                          </div>`
            }
        </div>`;
    }

    /** Beside a project's coordinator or thread: its threads by state, and its memory; a thread opens here. */
    function ProjectPanel() {
        const { data, failure: failed } = useProjects();
        const shown = useShown();
        const viewingNow = useViewing();
        const project = projectOf(data, shown);
        const thread =
            viewingNow === null
                ? undefined
                : project?.threads.find((each) => each.id === viewingNow.thread);
        const helper =
            viewingNow?.helper === undefined
                ? undefined
                : thread?.helpers?.find((each) => each.id === viewingNow.helper);

        // A thread of another project, or gone: the list again.
        useEffect(() => {
            if (data !== null && viewingNow !== null && thread === undefined) {
                view(null);
            }
        }, [data, viewingNow, thread]);

        if (data === null) {
            return failed
                ? html`<div class="error-box">${failed}</div>
                      <button class="button" onClick=${() => void refresh()}>Try again</button>`
                : html`<${Loader} label="Reading the project" />`;
        }

        if (project === undefined) {
            return html`<p class="muted">
                This session is not part of a project. Open a project from the list, or make one on
                the Projects page.
            </p>`;
        }

        if (thread !== undefined) {
            return html`<${ThreadView} thread=${thread} helper=${helper} />`;
        }

        // The project opens its coordinator; a thread opens here, in the panel.
        const open = (target) =>
            target.coordinator === project.coordinator
                ? pocket.openConversation(target.coordinator)
                : view({ thread: target.coordinator });

        return html`<div class="talaria-panel">
            ${project.summary && html`<p class="talaria-panel-summary">${project.summary}</p>`}
            <div class="sheet-list">
                <${Project} project=${project} open=${open} current=${shown} />
            </div>
        </div>`;
    }

    /** Chips on a session's row and on PiP's cards: a project's coordinator, or one of its threads. */
    function chipsOf(session) {
        const project = projectOf(latest, session.id);

        if (project === undefined) {
            return [];
        }

        if (project.coordinator === session.id) {
            const open = project.threads.filter((each) => each.state !== "resolved").length;
            const counts = countsOf(project);
            const asks = (counts.waiting ?? 0) + (counts.failed ?? 0);

            return [
                { label: "Project" },
                ...(open > 0 ? [{ label: `${open} open thread${open === 1 ? "" : "s"}` }] : []),
                ...(asks > 0 ? [{ label: `${asks} waiting on you` }] : []),
            ];
        }

        return [{ label: `Thread of ${project.name}` }];
    }

    const chips =
        typeof pocket.sessionChips === "function"
            ? pocket.sessionChips({ id: "projects", chips: chipsOf })
            : null;

    // The projects' sessions are reached from the projects above the list: the list leaves them out until this is off.
    if (typeof pocket.sessionFilter === "function") {
        filter = pocket.sessionFilter({
            id: "project-sessions",
            title: "Hide the sessions of projects (they are under Projects above)",
            iconPath: PROJECTS_PATH,
            match: (session) => keeps(session),
            run: () => {
                hiding = !hiding;
                filter.update({ match: hiding ? (session) => keeps(session) : null });
            },
        });
    }

    pocket.style("style.css");

    if (typeof pocket.sidebar === "function") {
        pocket.sidebar({ id: "projects", title: "Projects", component: ProjectsNav });
    }

    if (typeof pocket.panel === "function") {
        pocket.panel({
            id: "project",
            title: "Threads",
            iconPath: PROJECTS_PATH,
            component: ProjectPanel,
            // A tab of the dock beside a project's sessions, before Files.
            tab: () => projectOf(latest, pocket.conversationId()) !== undefined,
            // Outside a project it has nothing to show: the dock's button opens it where it is a tab.
            topbar: false,
        });

        // A project's coordinator opens with its threads beside it, where there is room; once a tab, for each.
        const opened = new Set();

        pocket.onConversation((id) => {
            if (id === null || opened.has(id) || !matchMedia("(min-width: 1100px)").matches) {
                return;
            }

            void refresh().then(() => {
                if (latest?.projects.some((project) => project.coordinator === id)) {
                    opened.add(id);

                    if (pocket.conversationId() === id) {
                        pocket.openPanel("project");
                    }
                }
            });
        });
    }

    // Project settings: a button in the top bar of a project's coordinator, for the owner only.
    pocket.sheet({ id: "project-settings", title: "Project settings", component: ProjectSettings });

    if (typeof pocket.topbar === "function" && pocket.me()?.role === "owner") {
        pocket.topbar({
            id: "project-settings",
            title: "Project settings",
            iconPath: GEAR_PATH,
            sheet: "project-settings",
        });

        // Shown only on a coordinator: elsewhere a CSS class keeps it out (`style.css`).
        const mark = () => {
            const here = latest?.projects.some(
                (project) => project.coordinator === pocket.conversationId(),
            );

            document.documentElement.toggleAttribute("data-talaria-coordinator", Boolean(here));
        };

        hearers.add(mark);
        pocket.onConversation(() => mark());
        void refresh().then(mark);
    }

    pocket.page({ id: "projects", title: "Projects", component: Projects });
    pocket.rail({ id: "projects", title: "Projects", iconPath: PROJECTS_PATH, page: "projects" });
    pocket.launcher({
        id: "projects",
        label: "Projects",
        detail: "Open a project's coordinator, or make a project",
        iconPath: PROJECTS_PATH,
        keywords: ["project", "coordinator", "thread"],
        page: "projects",
    });
}
