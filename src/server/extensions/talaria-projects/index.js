// Projects' browser module: a Projects button on the rail and in the launcher, and a page that lists the projects,
// newest activity first, opens a project's coordinator, and makes a new project. It uses only `pocket`.
export const pocketApi = 2;

/** Lucide's folder-kanban icon. */
const PROJECTS_PATH =
    "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z M8 10v4 M12 10v2 M16 10v6";

/** Thread groups in the order they need the person: what waits on them first. Resolved ones fold away. */
const GROUPS = [
    ["waiting", "Waiting on you"],
    ["failed", "Failed"],
    ["working", "Working"],
    ["review", "Ready for review"],
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
    const { html, useEffect, useState, Loader } = pocket;

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
        </div>`;
    }

    /** One project: its button, which opens the coordinator, then its threads by state; resolved ones folded away. */
    function Project({ project, open }) {
        const [showResolved, setShowResolved] = useState(false);
        const threads = project.threads ?? [];
        const stateOf = (each) => each.state ?? (each.resolved ? "resolved" : "idle");
        const resolved = threads.filter((each) => stateOf(each) === "resolved");
        const row = (each) =>
            html`<button
                type="button"
                class="list-item talaria-thread"
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
                class="list-item"
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
            }`;
    }

    pocket.style("style.css");
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
