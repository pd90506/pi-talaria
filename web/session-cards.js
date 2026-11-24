// Sessions an answer of PiP's links (a project's coordinator, a session it started), as cards under it: in PiP's
// floating panel (`pip.js`) and on its board (`transcript.js`).
import { folderColor } from "./avatar.js";
import { sessionChips } from "./extension-ui.js";
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** How many sessions one of PiP's answers shows as cards. */
const MAX_CARDS = 3;

/**
 * The sessions PiP's answer links (a project's coordinator, a session it started), as cards under it: each one's title,
 * where it stands, and what modules say of it (`sessionChips`: a project, its threads). A tap opens it.
 */
export function SessionCards({ text, onOpen }) {
    const sessions = store.state.sessions;
    const ids = [
        ...new Set(
            [...text.matchAll(/(?<![\w/.])\/s\/(\d+)\b(?![\w/])/g)].map((match) =>
                Number(match[1]),
            ),
        ),
    ];
    const shown = ids
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session) => session !== undefined)
        .slice(0, MAX_CARDS);

    if (shown.length === 0) {
        return null;
    }

    const open = (id) => {
        navigate(id);
        onOpen?.();
    };

    return html`<div class="pip-cards" data-part="pip-session-cards">
        ${shown.map((session) => {
            const state = session.waiting
                ? "needs you"
                : session.busy
                  ? "working"
                  : session.archived
                    ? "archived"
                    : "idle";
            const chips = sessionChips(session);

            return html`<button
                key=${session.id}
                type="button"
                class="pip-card"
                data-session=${session.id}
                aria-label=${`Open ${session.title ?? "the session"}, ${state}`}
                onClick=${() => open(session.id)}
            >
                <span
                    class="folder-mark"
                    style=${`--folder:${folderColor(session.cwd)}`}
                    aria-hidden="true"
                ></span>
                <span class="pip-card-text">
                    <span class="pip-card-title">${session.title ?? "New session"}</span>
                    <span class="pip-card-detail">
                        <span class=${`pip-card-state ${state.replace(" ", "-")}`}>${state}</span>
                        ${chips.map(
                            (chip) => html`<span key=${chip.key ?? chip.label} class="pip-card-chip"
                                >${chip.label}</span
                            >`,
                        )}
                    </span>
                </span>
                <${Icon} name="chevron" size=${14} />
            </button>`;
        })}
    </div>`;
}
