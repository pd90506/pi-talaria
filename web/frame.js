// A session shown inside another page of the app, in a frame (`?frame=thread`): a project's thread beside its
// coordinator, in the side dock. The frame draws only the conversation and its message box; going to another session
// goes in the page around it.

/** Whether this page is a session in a frame of the app's own: read once, as the page loads. */
export const framed =
    new URLSearchParams(location.search).get("frame") === "thread" &&
    window.parent !== window &&
    (() => {
        try {
            return window.parent.location.origin === location.origin;
        } catch {
            return false;
        }
    })();

/** Ask the page around the frame to open a session: it goes there, and the frame stays as it is. */
export function openAround(conversationId) {
    window.parent.postMessage({ pocketOpen: conversationId }, location.origin);
}

/** In the page around frames: a frame asked to open a session. `go` opens it. */
export function hearFrames(go) {
    addEventListener("message", (event) => {
        if (event.origin !== location.origin || event.source === window) {
            return;
        }

        const id = event.data?.pocketOpen;

        if (typeof id === "number" || id === null) {
            go(id);
        }
    });
}
