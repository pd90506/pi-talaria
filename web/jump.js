// Jump to a message in the transcript: scroll to it and flash it, loading earlier history first when needed.

import { closeSheet, isLoaded, loadEarlier, notify, revealEntry, store } from "./store.js";

/** The newest jump: an earlier one still loading gives way to it. */
let jumps = 0;

/**
 * Close the sheet and scroll the transcript to a message, briefly highlighted. Resolves
 * true once it shows, false when it cannot: not in the session's transcript, the session changed, or a newer jump came.
 * `quiet` leaves the "earlier history" notice to the caller (`pocket.reveal`).
 */
export function jumpToEntry(entryId, { quiet = false } = {}) {
    closeSheet();
    const jump = ++jumps;
    const { view, conversationId } = store.state;
    const current = () => jump === jumps && store.state.conversationId === conversationId;

    // In the session but not loaded yet (a view brings only the newest): load back to it first.
    if (view.order.includes(entryId) && !isLoaded(view, entryId)) {
        return loadEarlier({ from: entryId }).then(
            () => current() && isLoaded(store.state.view, entryId) && show(entryId, jump, quiet),
            (error) => {
                notify("error", error.message ?? String(error));

                return false;
            },
        );
    }

    return show(entryId, jump, quiet);
}

/** The scroll and flash of a jump, once the entry is loaded. */
function show(entryId, jump, quiet) {
    // A message above the rows the transcript shows: show from it down. The render runs before the next frame.
    revealEntry(entryId);
    // An answer of only tool calls is a mark in a group of Pi's calls: the group opens (transcript.js).
    document.dispatchEvent(new CustomEvent("pocket:reveal", { detail: entryId }));

    return new Promise((resolve) =>
        requestAnimationFrame(() => {
            const found = document.getElementById(`entry-${entryId}`);

            if (jump !== jumps) {
                return resolve(false);
            }

            if (!found) {
                if (!quiet) {
                    notify(
                        "info",
                        "That message is in earlier history: use “Show earlier messages” at the top.",
                    );
                }

                return resolve(false);
            }

            // The mark has no size: its group's line is what shows.
            const element = found.classList.contains("entry-anchor")
                ? (found.closest(".activity")?.querySelector(".activity-head") ?? found)
                : found;

            // A long one from its top, where it starts: centered, its middle would show, and what was found may be above.
            const tall = element.getBoundingClientRect().height > innerHeight / 2;
            const still = document.documentElement.dataset.motion === "reduced";

            element.scrollIntoView({
                block: tall ? "start" : "center",
                behavior: still ? "auto" : "smooth",
            });
            element.classList.remove("flash");
            void element.offsetWidth;
            element.classList.add("flash");
            resolve(true);
        }),
    );
}
