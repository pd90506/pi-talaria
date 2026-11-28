// The side dock beside the conversation, after Claude's desktop app: one row of tabs over whichever panel shows there.
// Its tabs are modules' panels that ask to be one (a project's Threads), then Files, Changes, and Browser. One panel
// shows at a time (`browser.js`, `files-panel.js`, `extension-ui.js` keep which); a tab opens its panel in that place.
import { browserAvailable, setBrowserOpen } from "./browser.js";
import { dockPanels, openExtPanel } from "./extension-ui.js";
import { filesAvailable, setFilesOpen } from "./files-panel.js";
import { store } from "./store.js";
import { html, Icon } from "./ui.js";

/** The side dock's tabs now: `{ key, label, on, open }`, `on` for the one that shows. */
export function dockTabs(state = store.state) {
    const tabs = dockPanels().map((panel) => ({
        key: `ext:${panel.module}:${panel.id}`,
        label: panel.title,
        on: panel.open,
        open: () => openExtPanel(panel.module, panel.id),
    }));

    if (filesAvailable()) {
        tabs.push(
            {
                key: "files",
                label: "Files",
                on: state.filesOpen && state.filesTab === "files",
                open: () => setFilesOpen(true, "files"),
            },
            {
                key: "changes",
                label: "Changes",
                on: state.filesOpen && state.filesTab === "changes",
                open: () => setFilesOpen(true, "changes"),
            },
        );
    }

    if (browserAvailable() && state.conversationId !== null) {
        tabs.push({
            key: "browser",
            label: "Browser",
            on: state.browserOpen,
            open: () => setBrowserOpen(true),
        });
    }

    return tabs;
}

/** The tab the side dock showed last: its button opens the dock there again. */
let lastTab = null;

/**
 * The top bar's one button for the side dock, as Claude's desktop app has: it opens the dock on the tab it showed last
 * (the first tab, at first), and closes it. Out of the top bar where its pane is narrow (`top-toggle`): the menu's rows
 * open each tab there.
 */
export function DockButton() {
    const tabs = dockTabs();

    if (tabs.length === 0) {
        return null;
    }

    const shown = tabs.find((tab) => tab.on);

    if (shown !== undefined) {
        lastTab = shown.key;
    }

    const open = () => (tabs.find((tab) => tab.key === lastTab) ?? tabs[0]).open();

    return html`<button
        class=${`icon-button top-toggle ${shown ? "on" : ""}`}
        aria-label="Side panel"
        aria-pressed=${shown !== undefined}
        title=${`Side panel: ${tabs.map((tab) => tab.label).join(", ")}`}
        onClick=${() => (shown ? closeDock() : open())}
    >
        <${Icon} name="dock" size=${18} />
    </button>`;
}

/** Close whatever panel the side dock shows. */
export function closeDock() {
    store.set({ filesOpen: false, browserOpen: false, extPanel: null });
}

/** Whether a module's panel is one of the side dock's tabs now: its head is the dock's then. */
export const isDockTab = (module, id) =>
    dockPanels().some((panel) => panel.module === module && panel.id === id);

/**
 * The side dock's head, at the top of the panel beside the conversation: its tabs, and a close button. `counts` puts a
 * number on a tab, by its key (`{ changes: 3 }`).
 */
export function DockHead({ counts = {} }) {
    const tabs = dockTabs();

    return html`<header class="dock-head" data-part="dock-head">
        <div class="dock-tabs" role="tablist" aria-label="Beside the conversation">
            ${tabs.map(
                (tab) => html`<button
                    key=${tab.key}
                    type="button"
                    role="tab"
                    data-tab=${tab.key}
                    aria-selected=${tab.on ? "true" : "false"}
                    class=${tab.on ? "on" : ""}
                    onClick=${() => !tab.on && tab.open()}
                >
                    ${tab.label}
                    ${counts[tab.key] > 0 && html`<span class="dock-count">${counts[tab.key]}</span>`}
                </button>`,
            )}
        </div>
        <button
            class="icon-button dock-close"
            type="button"
            aria-label="Close the panel"
            title="Close"
            onClick=${closeDock}
        >
            <${Icon} name="close" size=${17} />
        </button>
    </header>`;
}
