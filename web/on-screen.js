// What is on screen, told to the server: the sessions and subagents whose rows show (the subagents bar and board) stay
// live. Once scrolling settles, the tab tells the server which (`POST /api/peeks`); the rest keep the lines they last
// had.
import { useEffect, useRef } from "preact/hooks";
import { onPageVisibility, pageVisible } from "./host.js";
import { api, store } from "./store.js";

/** How long the rows on screen must stay put before the server hears of them: scrolling past is not looking. */
const SETTLE_MS = 250;
/** As many as the server keeps live for a tab (`MAX_PEEKS`). */
const MAX_LIVE = 20;
/** A call may be allowed from a row only when its whole command shows there: this long at most, on one line. */
const ALLOW_LENGTH = 80;
/** Waits before sending the list again after a send failed, growing with each failure. */
const RETRY_MS = [1000, 3000, 10_000];

const hidden = () => !pageVisible();

store.set({ peeks: {} });

/** Each element the observers watch, and whether it is on screen. */
const onScreen = new Map();
let settleTimer = 0;
/** The connection and list last sent, so the same list is not sent twice. */
let sentKey = null;
let lastStream;
/** Numbers each list, so the server drops one that arrives after a newer one. */
let seq = 0;
let failures = 0;

function screenIds() {
    // A hidden tab looks at nothing: its rows stop until it shows again.
    if (hidden()) {
        return [];
    }

    // Sessions first, so subagent rows cannot take the room a session needs; the rows after them.
    const tiles = [];
    const agents = [];

    for (const [element, visible] of onScreen) {
        if (!element.isConnected) {
            onScreen.delete(element);
        } else if (visible) {
            (element.dataset.peekKind === "agent" ? agents : tiles).push(
                Number(element.dataset.peek),
            );
        }
    }

    return [...new Set([...tiles, ...agents])].slice(0, MAX_LIVE);
}

function settle(delay = SETTLE_MS) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(sendScreen, delay);
}

function sendScreen() {
    const { server, streamId } = store.state;

    if (server?.peeks !== true || !streamId) {
        return;
    }

    const ids = screenIds();
    const key = `${streamId}:${ids.join(",")}`;

    if (key === sentKey) {
        return;
    }

    // A connection starts without a list: nothing on screen yet needs nothing sent.
    if (ids.length === 0 && !sentKey?.startsWith(`${streamId}:`)) {
        sentKey = key;

        return;
    }

    sentKey = key;
    api("peeks", { connection: streamId, seq: ++seq, ids }).then(
        () => {
            failures = 0;
        },
        () => {
            // Try again soon: a moment without the network must not leave the rows stale.
            sentKey = null;
            settle(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
        },
    );
}

// Each connection to the server starts with nothing live (a reconnect or a restart; a session switch keeps the
// connection): say again what is on screen.
store.subscribe((state) => {
    if (state.streamId !== lastStream) {
        lastStream = state.streamId;
        settle(0);
    }
});

onPageVisibility(() => {
    settle(hidden() ? 0 : SETTLE_MS);
});

/**
 * Watch a scrolling list's `[data-peek]` elements (a session, or a subagent with `data-peek-kind="agent"`) for being on
 * screen, and tell the server once they settle: the subagents bar and board keep their rows live this way.
 */
export function useOnScreen(list) {
    const observer = useRef(null);
    const watched = useRef(new Set());

    useEffect(() => {
        const watcher = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (watched.current.has(entry.target)) {
                        onScreen.set(entry.target, entry.isIntersecting);
                    }
                }

                settle();
            },
            { root: list.current },
        );

        observer.current = watcher;

        return () => {
            watcher.disconnect();

            for (const element of watched.current) {
                onScreen.delete(element);
            }

            watched.current.clear();
            settle();
        };
    }, []);

    // New rows join the watch; rows that went leave it.
    useEffect(() => {
        let gone = false;

        for (const element of list.current.querySelectorAll("[data-peek]")) {
            if (!watched.current.has(element)) {
                watched.current.add(element);
                observer.current.observe(element);
            }
        }

        for (const element of watched.current) {
            if (!element.isConnected) {
                observer.current.unobserve(element);
                watched.current.delete(element);
                onScreen.delete(element);
                gone = true;
            }
        }

        if (gone) {
            settle();
        }
    });
}

/**
 * Whether a call's command is short enough to show whole in a row: only then may it be allowed from there.
 */
export const wholeOnTile = (approval) =>
    approval.subject.length <= ALLOW_LENGTH && !/[\r\n]/.test(approval.subject);
