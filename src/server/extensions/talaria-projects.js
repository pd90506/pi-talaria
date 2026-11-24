// Projects' browser module: a page with every project, most recently active first, each with its coordinator and
// its threads, and a form to make a new one (`talaria-projects.ts`).

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 1;

/** A folder, as a 24×24 stroked path like the app's own icons. */
const FOLDER = "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z";

const when = (at) => new Date(at).toLocaleString();

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    function NewProject({ onMade }) {
        const [name, setName] = useState("");
        const [purpose, setPurpose] = useState("");
        const [folders, setFolders] = useState("");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);

        const submit = async (event) => {
            event.preventDefault();
            setBusy(true);

            try {
                const made = await pocket.api("projects", {
                    name,
                    purpose,
                    folders: folders
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line !== ""),
                });

                setName("");
                setPurpose("");
                setFolders("");
                setError(null);
                onMade(made);
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<form class="talaria-new-project" onSubmit=${submit}>
            <h3>New project</h3>
            <input
                class="input"
                placeholder="Name"
                value=${name}
                onInput=${(event) => setName(event.target.value)}
            />
            <textarea
                class="input"
                rows="3"
                placeholder="What it is for"
                value=${purpose}
                onInput=${(event) => setPurpose(event.target.value)}
            ></textarea>
            <textarea
                class="input"
                rows="2"
                placeholder="Folders its threads may work in, one per line (~/repo/…)"
                value=${folders}
                onInput=${(event) => setFolders(event.target.value)}
            ></textarea>
            ${error ? html`<div class="error-box">${error}</div>` : null}
            <button class="button" type="submit" disabled=${busy || name.trim() === ""}>
                Make project
            </button>
        </form>`;
    }

    function Projects() {
        const [projects, setProjects] = useState(null);
        const [error, setError] = useState(null);
        const [archived, setArchived] = useState(false);

        const refresh = async () => {
            try {
                setProjects(await pocket.api("projects"));
                setError(null);
            } catch (failure) {
                setError(failure.message);
            }
        };

        useEffect(() => {
            void refresh();
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>
                <button class="button" onClick=${refresh}>Try again</button>`;
        }

        if (!projects) {
            return html`<${Loader} label="Reading projects" />`;
        }

        const shown = projects.filter((project) => (project.status === "archived") === archived);

        return html`<div class="talaria-projects">
            <div class="setting">
                <div class="grow">${archived ? "Archived projects" : "Projects"}</div>
                <button class="button" onClick=${() => setArchived(!archived)}>
                    ${archived ? "Show active" : "Show archived"}
                </button>
            </div>
            ${shown.length === 0 ? html`<p class="muted small">No projects here yet.</p>` : null}
            ${shown.map(
                (project) =>
                    html`<div class="talaria-project">
                        <div class="setting">
                            <button
                                class="grow link"
                                onClick=${() => pocket.openConversation(project.coordinator)}
                            >
                                ${project.name}
                            </button>
                            <div class="muted small">${when(project.updatedAt)}</div>
                        </div>
                        <div class="muted small mono">${project.folder}</div>
                        ${project.threads.map(
                            (thread) =>
                                html`<div class="setting small">
                                    <button
                                        class="grow link"
                                        onClick=${() => pocket.openConversation(thread.id)}
                                    >
                                        ${thread.archived ? "✓ " : ""}${thread.title}
                                    </button>
                                    <div class="muted small">${when(thread.updatedAt)}</div>
                                </div>`,
                        )}
                    </div>`,
            )}
            <${NewProject}
                onMade=${(made) => {
                    void refresh();
                    pocket.openConversation(made.coordinator);
                }}
            />
        </div>`;
    }

    pocket.page({ id: "projects", title: "Projects", component: Projects });
    pocket.rail({ id: "projects", title: "Projects", iconPath: FOLDER, page: "projects" });
}
