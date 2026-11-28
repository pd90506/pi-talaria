// A phone's keyboard. iOS Safari keeps the page as tall as the screen while the keyboard is up (it does not honor
// `interactive-widget=resizes-content`), and pans the whole page up to show the field: the top bar goes under the
// status bar, and a band of the page shows between the message box and the keyboard. While the keyboard is up, the
// app takes the height of what shows above it instead (`--keyboard-room`, `data-keyboard` on the page's root; style.css),
// and the pan goes back to 0. Browsers that resize the page for the keyboard (Chrome on Android) never set it.

/** Less than this between the page and what shows of it is a bar of the browser's, not a keyboard. */
const KEYBOARD_MIN = 120;

const root = document.documentElement;
const view = window.visualViewport;
const typing = () =>
    document.activeElement?.matches?.("input, textarea, [contenteditable]") === true;

let frame = 0;

function fit() {
    frame = 0;

    const covered = innerHeight - view.height;

    if (covered > KEYBOARD_MIN && typing()) {
        const room = `${Math.round(view.height)}px`;

        if (root.style.getPropertyValue("--keyboard-room") !== room) {
            root.style.setProperty("--keyboard-room", room);
        }

        if (root.dataset.keyboard === undefined) {
            root.dataset.keyboard = "";
        }

        // What iOS panned to show the field: the app now fits above the keyboard, so nothing needs to pan.
        if (scrollY !== 0 || view.offsetTop !== 0) {
            scrollTo(0, 0);
        }
    } else if (root.dataset.keyboard !== undefined) {
        delete root.dataset.keyboard;
        root.style.removeProperty("--keyboard-room");
    }
}

const later = () => {
    frame ||= requestAnimationFrame(fit);
};

if (view && matchMedia("(pointer: coarse)").matches) {
    view.addEventListener("resize", later);
    view.addEventListener("scroll", later);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", () => setTimeout(later, 50));
}
