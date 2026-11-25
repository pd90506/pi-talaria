// Running now's two views, one board in the conversation's place: the sessions (what runs and what is scheduled,
// `running-board.js`) and the subagents (every subagent in every session, `subagents-board.js`). A switch in the
// board's head moves between them; the sidebar's Running now row opens the sessions.
import { store } from "./store.js";
import { html } from "./ui.js";

const VIEWS = [
    { board: "running", label: "Sessions" },
    { board: "subagents", label: "Subagents" },
];

/** Show one of Running now's views, `"running"` or `"subagents"`. */
export const showBoard = (board) =>
    store.state.board !== board &&
    store.set({
        board,
        boardAgents: null,
        boardFilter: null,
        drawer: false,
        page: null,
        sheet: null,
    });

/** The switch between Running now's views, in its head. */
export function BoardTabs() {
    const { board } = store.state;

    return html`<div class="segmented board-tabs" role="tablist" aria-label="Running now">
        ${VIEWS.map(
            (view) => html`<button
                type="button"
                role="tab"
                data-board=${view.board}
                aria-selected=${board === view.board ? "true" : "false"}
                class=${board === view.board ? "on" : ""}
                onClick=${() => showBoard(view.board)}
            >
                ${view.label}
            </button>`,
        )}
    </div>`;
}
