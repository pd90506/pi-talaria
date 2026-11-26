// The menu: what can be done in this session and in the app.
import { useLayoutEffect, useRef } from "preact/hooks";
import { browserAvailable, displayUrl, setBrowserOpen } from "../browser.js";
import { schedulesAvailable, triggersOn, watchAvailable, watchPr } from "../commands.js";
import { extensionMenuItems, safeMode } from "../extension-ui.js";
import { hostMenu } from "../embedder.js";
import { useChanges } from "../diff.js";
import { filesAvailable } from "../files-panel.js";
import { dockTabs } from "../side-dock.js";
import { modelRefreshAvailable, refreshModels } from "../model-refresh.js";
import { setArchived } from "../sessions.js";
import { openSubagent } from "../subagents.js";
import {
    api,
    attempt,
    canSteer,
    closeSheet,
    navigate,
    notify,
    openRunning,
    openSheet,
    scoped,
    setUnread,
    signOut,
    store,
} from "../store.js";
import { isPinned, lookLabel, togglePin } from "../theme.js";
import { currentTrust, trustAvailable } from "../trust.js";
import { defaultLabel, defaultsKept } from "./model.js";
import { copyText, html, item, Sheet, shortPath } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** The menu's word on the session's schedules: how many go out, and how many are paused. */
function schedulesHint(schedules) {
    const paused = schedules.filter((each) => each.paused !== undefined).length;
    const coming = schedules.length - paused;

    if (schedules.length === 0) {
        return "none";
    }

    return [coming > 0 && `${coming} coming`, paused > 0 && `${paused} paused`]
        .filter(Boolean)
        .join(" · ");
}

/** The Extensions row's hint: that this tab loads none of their browser parts (safe mode). */
function extensionsHint() {
    return safeMode() ? "browser parts off here" : "";
}

/**
 * What opens beside the conversation, as rows at the top of the menu: Files, Changes, the browser, and extensions'
 * panels, the side dock's tabs (`side-dock.js`). On a phone, where the top bar keeps few buttons, this is where they are.
 */
function Beside() {
    if (!store.state.view.conversation) {
        return null;
    }

    return filesAvailable() ? html`<${BesideWithChanges} />` : html`<${BesideRows} />`;
}

/** Only people who can open Files request its shared changes data, just as the top bar does. */
function BesideWithChanges() {
    const { changes } = useChanges();

    return html`<${BesideRows} changes=${changes} />`;
}

function BesideRows({ changes = null }) {
    // Match the top bar: uncommitted files in a repository, Pi's edits elsewhere, plus any unlisted files.
    const count = changes
        ? changes.files.length + (changes.repo ? 0 : changes.piOnly.length) + (changes.more ?? 0)
        : 0;
    const counts = { changes: count };
    const tabs = dockTabs();

    if (tabs.length === 0) {
        return null;
    }

    return html`<div class="group menu-beside" aria-label="Beside the conversation">
        ${tabs.map((tab) =>
            item(
                tab.label,
                () => {
                    tab.open();
                    closeSheet();
                },
                [tab.on && "open", counts[tab.key] > 0 && `${counts[tab.key]} changed`]
                    .filter(Boolean)
                    .join(" · "),
            ),
        )}
    </div>`;
}

/** Keep Sheet's Esc, drag, and focus handling; the sheet trail already owns its back-stack layer. */
function MenuFrame({ title, children }) {
    const host = useRef(null);

    useLayoutEffect(() => {
        const element = host.current;
        const button = document.querySelector('.topbar [aria-label="Menu"]');
        const active = document.activeElement;
        const opener = active === document.body ? button : active;

        const place = () => {
            const rect = button?.getBoundingClientRect();
            const top = (rect?.bottom ?? 58) + 6;
            const bottom =
                (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight);
            const left = Math.max(
                8,
                Math.min((rect?.right ?? innerWidth - 8) - 360, innerWidth - 368),
            );

            element.style.setProperty("--menu-left", `${left}px`);
            element.style.setProperty("--menu-top", `${top}px`);
            element.style.setProperty("--menu-height", `${Math.max(100, bottom - top - 8)}px`);
        };

        const body = element.querySelector(".sheet-body");

        if (menuScroll !== null) {
            body.scrollTop = menuScroll;
            menuScroll = null;
        }

        place();
        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);

            // Another sheet open now: the menu is going back under it, not closing.
            if (store.state.sheet) {
                menuScroll = body.scrollTop;
            }

            const focused = document.activeElement;
            const back = opener?.isConnected ? opener : button;
            // As sheets.js does: not behind a sheet the menu opened, and not into a text field on a touch screen,
            // where its keyboard would pop up.
            const field =
                matchMedia("(pointer: coarse)").matches &&
                back?.matches("input, textarea, [contenteditable]");

            if (
                !store.state.sheet &&
                !field &&
                (focused === document.body || element.contains(focused)) &&
                back?.isConnected
            ) {
                back.focus({ preventScroll: true });
            }
        };
    }, []);

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }

        const items = [...host.current.querySelectorAll(".list-item")];
        const active = document.activeElement;
        const index = items.indexOf(active);
        let target;

        if (event.key === "Tab") {
            // Close stays reachable with Tab, but is not part of the menu's item navigation.
            const controls = [...items, ...host.current.querySelectorAll(".sheet-head button")];
            const at = controls.indexOf(active);
            const next =
                at < 0
                    ? event.shiftKey
                        ? controls.length - 1
                        : 0
                    : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;

            target = controls[next];
        } else if (event.key === "Home") {
            target = items[0];
        } else if (event.key === "End") {
            target = items.at(-1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const down = event.key === "ArrowDown";
            const next = index < 0 ? (down ? 0 : items.length - 1) : index + (down ? 1 : -1);

            target = items[(next + items.length) % items.length];
        }

        if (target) {
            event.preventDefault();
            target.focus();
        }
    };

    return html`<div class="nav-menu-host" data-part="menu" ref=${host} onKeyDown=${onKey}>
        <${Sheet} title=${title} onClose=${closeSheet} className="nav-menu">
            ${children}
        <//>
    </div>`;
}

/** The menu's scroll, kept while a sheet it opened shows, so back finds the menu where it was left. */
let menuScroll = null;

store.subscribe(({ sheet }) => {
    if (!sheet) {
        menuScroll = null;
    }
});

/** The project's trust in a word, once the server said. */
function trustHint() {
    const info = currentTrust();

    if (!info) {
        return "";
    }

    if (info.ask) {
        return "not decided";
    }

    // No decision, and nothing waiting for one: there is nothing to say.
    if (info.saved === null && info.defaultProjectTrust === "ask") {
        return "";
    }

    return info.trusted ? "trusted" : "not trusted";
}

/** The menu. */
export function MenuSheet() {
    const { view, me, server } = store.state;
    const conversation = view.conversation;
    const steer = canSteer();
    const session = conversation?.kind === "session";

    // The embedder this page runs in adds its own group at the end, below App, under its own title (`embedder.js`).
    const embedder = hostMenu();

    return html`<${MenuFrame} title=${conversation?.title ?? "Menu"}>
        <${Beside} />
        <div class="menu-session">
            ${session && steer && item("Rename", () => openSheet({ type: "rename" }))}
            ${
                session &&
                item(
                    isPinned(conversation.id) ? "Unpin from the top" : "Pin to the top",
                    () => {
                        togglePin(conversation.id);
                        closeSheet();
                    },
                    "this browser",
                )
            }
            ${
                session &&
                item(
                    "Mark unread",
                    () => {
                        setUnread(conversation.id, true);
                        closeSheet();
                        navigate(null);
                    },
                    "this browser; opening it again clears it",
                )
            }
            ${
                conversation?.worktree && steer
                    ? item(
                          "Worktree",
                          () => openSheet({ type: "worktree" }),
                          conversation.worktree.branch,
                      )
                    : conversation &&
                      steer &&
                      !scoped() &&
                      item(
                          "Working directory",
                          () => openSheet({ type: "cwd", mode: "change" }),
                          shortPath(view.agent?.cwd, server?.home),
                      )
            }
            ${
                conversation &&
                browserAvailable() &&
                store.state.browserOpen &&
                item(
                    "Close the browser",
                    () => {
                        setBrowserOpen(false);
                        closeSheet();
                    },
                    store.state.browser?.open && displayUrl(store.state.browser.url),
                )
            }
            ${conversation && trustAvailable() && item("Project trust", () => openSheet({ type: "trust" }), trustHint())}
            ${session && extensionMenuItems("session").map((each) => item(each.label, each.run, each.hint))}
            ${conversation && steer && item("Compact context", () => openSheet({ type: "compact" }), "summarize older messages")}
            ${conversation && steer && item("New context", () => openSheet({ type: "reset" }), "Pi starts fresh; history stays")}
            ${schedulesAvailable() && item("Scheduled messages", () => openSheet({ type: "schedules" }), schedulesHint(view.schedules))}
            ${
                watchAvailable() &&
                steer &&
                view.watch?.status !== "watching" &&
                item(
                    "Watch pull request",
                    () => {
                        closeSheet();
                        attempt(() => watchPr());
                    },
                    "fix CI, answer reviews",
                )
            }
            ${
                conversation &&
                item("Copy link", () =>
                    copyText(location.href).then(
                        () => notify("info", "Link copied. Other signed-in devices can open it."),
                        () => notify("error", "Could not copy."),
                    ),
                )
            }
            ${
                conversation &&
                html`<a class="list-item" href=${`/api/c/${conversation.id}/export`} download>
                    <span>Export as Markdown</span>
                    <span class="muted small">the whole history</span>
                </a>`
            }
            ${
                session &&
                steer &&
                item(conversation.archived ? "Unarchive" : "Archive", () => {
                    closeSheet();
                    setArchived([conversation.id], !conversation.archived);
                })
            }
        </div>
        ${
            view.subagents.length > 0 &&
            html`<div class="group">
                <div class="group-title">Subagents</div>
                ${view.subagents.map((agent) =>
                    item(
                        html`${agent.busy ? html`<span class="pulse"></span> ` : ""}${agent.name}`,
                        () => openSubagent(agent.conversationId),
                        agent.busy ? "working" : "idle",
                    ),
                )}
            </div>`
        }
        <div class="group">
            <div class="group-title">App</div>
            ${item("Appearance", () => openSheet({ type: "appearance" }), lookLabel())}
            ${!touch && item("Keyboard shortcuts", () => openSheet({ type: "shortcuts" }), "?")}
            ${
                me?.role === "owner" &&
                defaultsKept() &&
                item(
                    "Default model",
                    () => openSheet({ type: "model", id: "default", forDefault: true }),
                    defaultLabel(server?.defaultModel, store.state.models) ||
                        "project, last picked, then Pi global",
                )
            }
            ${item("Sign in another device", () => openSheet({ type: "device" }))}
            ${item("Notifications", () => openSheet({ type: "notifications" }), "Pi finished, approvals")}
            ${item("Running now", openRunning, "everything Pi is doing")}
            ${view.conversation && item("Background", () => openSheet({ type: "background" }), "what commands print as they run")}
            ${item("Spend", () => openSheet({ type: "spend" }), me?.role === "owner" ? "by person and session, limits" : "yours")}
            ${triggersOn() && me?.role !== "viewer" && item("Webhooks and watches", () => openSheet({ type: "hooks" }), "GitHub, other services")}
            ${me?.role === "owner" && item("Providers", () => openSheet({ type: "providers" }))}
            ${modelRefreshAvailable() && item("Refresh models", refreshModels, store.state.modelRefresh.loading ? "refreshing…" : "models.json and providers")}
            ${extensionMenuItems().map((each) => item(each.label, each.run, each.hint))}
            ${item("Extensions", () => openSheet({ type: "extensions" }), extensionsHint())}
            ${me?.role === "owner" && item("Versions", () => openSheet({ type: "versions" }), "update, go back")}
            ${
                me?.role === "owner" &&
                server?.supervised &&
                item(
                    "Restart server",
                    () =>
                        attempt(async () => {
                            await api("restart", {});
                            closeSheet();
                            notify("info", "Restarting. Running work continues after the restart.");
                        }),
                    "running work resumes",
                )
            }
            ${item(html`<span class="menu-signout">Sign out</span>`, signOut)}
        </div>
        ${
            embedder.items.length > 0 &&
            html`<div class="group">
                ${embedder.title && html`<div class="group-title">${embedder.title}</div>`}
                ${embedder.items.map((each) => item(each.label, each.run, each.hint))}
            </div>`
        }
    <//>`;
}
