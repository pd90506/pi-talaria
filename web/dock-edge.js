// The side dock's left edge: drag it to resize whichever panel shows beside the conversation (Threads, Files, Changes,
// Browser). They share one width (`--dock-w`), kept in this browser, so switching tabs does not jump; a double click
// puts each panel back to its own usual width.
import { dragWidth, html } from "./ui.js";

const WIDTH_KEY = "pocket.dockWidth";

/** The narrowest the dock goes, and the room the conversation keeps beside it. */
export const DOCK_MIN = 320;
const PANE_MIN = 420;

function storedWidth() {
    try {
        return Number(localStorage.getItem(WIDTH_KEY)) || 0;
    } catch {
        return 0;
    }
}

function keep(width) {
    try {
        if (width === null) {
            localStorage.removeItem(WIDTH_KEY);
        } else {
            localStorage.setItem(WIDTH_KEY, String(width));
        }
    } catch {
        // Storage off: the width holds until the page reloads.
    }

    if (width === null) {
        document.documentElement.style.removeProperty("--dock-w");
    } else {
        document.documentElement.style.setProperty("--dock-w", `${width}px`);
    }
}

/** The widest the dock may be now: the conversation keeps `PANE_MIN` beside it. */
function dockMax(panel) {
    const right = panel.getBoundingClientRect().right;
    const pane = document.querySelector(".layout > .pane");
    const left = pane ? pane.getBoundingClientRect().left : 0;

    return Math.max(DOCK_MIN, right - left - PANE_MIN);
}

/** Drag the panel's left edge to resize it on wide screens; double-click goes back to its usual width. */
export function DockEdge({ className = "" }) {
    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const panel = event.currentTarget.parentElement;
        const right = panel.getBoundingClientRect().right;
        const max = dockMax(panel);

        dragWidth(event, {
            element: panel,
            property: "flex-basis",
            widthAt: (each) => Math.round(Math.min(max, Math.max(DOCK_MIN, right - each.clientX))),
            done: (width) => keep(width),
        });
    };

    return html`<div
        class=${`resize-handle dock-resize ${className}`}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown=${start}
        onDblClick=${() => keep(null)}
    ></div>`;
}

const saved = storedWidth();

if (saved > 0) {
    document.documentElement.style.setProperty("--dock-w", `${saved}px`);
}
