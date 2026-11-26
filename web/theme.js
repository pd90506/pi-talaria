// Appearance: one fixed look, after Claude Code's desktop app, in light or dark (Appearance → Mode: System, Light, or
// Dark), the conversation's text size, and a few choices of how things behave. Saved per browser. index.html applies the
// last look before the first paint from `pocket.themeCache`, so a reload never flashes the other mode.
import { applyIcons, reportIconsAs } from "./app-icon.js";
import { onSafeModeEnd } from "./safe-mode.js";
import { store } from "./store.js";

const KEY = "pocket.appearance";
const CACHE = "pocket.themeCache";
const PINNED = "pocket.pinned";

/** The conversation's text size in pixels: anything from MIN_TEXT to MAX_TEXT, in steps of STEP_TEXT. */
export const MIN_TEXT = 10;
export const MAX_TEXT = 32;
export const STEP_TEXT = 0.5;

/** A text size someone typed or saved, kept in range and on a step; the default for one that is not a number. */
export function textSizeOf(value) {
    const size = Number(value);

    if (value === null || value === "" || !Number.isFinite(size)) {
        return 15;
    }

    return Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.round(size / STEP_TEXT) * STEP_TEXT));
}

/** The two palettes of the app's one look: warm paper and ink, with Claude's clay as the accent. */
export const PALETTES = {
    light: {
        mode: "light",
        accent: "#c96442",
        selection: "#e8e6dc",
        background: "#faf9f5",
        dark_background: "#f5f4ed",
        darker_background: "#f0eee6",
        lighter_background: "#ffffff",
        foreground: "#3d3d3a",
        dark_foreground: "#73726c",
        light_foreground: "#3d3d3a",
        bright_foreground: "#141413",
        red: "#b5402e",
        yellow: "#a1700d",
        orange: "#c96442",
        green: "#4f7d2f",
        cyan: "#2c7380",
        blue: "#2f68b0",
        magenta: "#8150b8",
    },
    dark: {
        mode: "dark",
        accent: "#d97757",
        selection: "#3a3936",
        background: "#262624",
        dark_background: "#1f1e1d",
        darker_background: "#1a1918",
        lighter_background: "#30302e",
        foreground: "#c2c0b6",
        dark_foreground: "#8f8d85",
        light_foreground: "#d6d4cb",
        bright_foreground: "#faf9f5",
        red: "#e5735f",
        yellow: "#e2b552",
        orange: "#d97757",
        green: "#93c06d",
        cyan: "#71b6bb",
        blue: "#7ea9e1",
        magenta: "#b79ae6",
    },
};

const DEFAULTS = {
    /** "system" follows the system's light or dark; "light" or "dark" stays on one. */
    mode: "system",
    /** The conversation's text in pixels, MIN_TEXT to MAX_TEXT; the rest of the app keeps its own sizes. */
    text: 15,
    /**
     * Where PiP opens: "board" (the default), its own conversation in the session's place, as a session opens; or
     * "floating", a window in the corner (a sheet from the bottom on a phone), over what shows (`pip.js`).
     */
    pip: "board",
    /** How the session list groups: "priority" (by what needs you), "recent" (by day), or "folder". */
    group: "recent",
    /** How fast the last answer came, in the status line under the message box. Off until turned on. */
    speed: false,
    /** Pi's current thought above the live line, and its finished thoughts open. Off until turned on. */
    showThinking: false,
    /**
     * Pi's thinking and tool calls stay folded into their one line until opened, also while they run and in the newest
     * turn; off, the newest turn's groups open as they come. A group opened or closed by hand keeps that choice, and a
     * thought alone in its group still follows Show thinking. Off until turned on.
     */
    foldActivity: false,
    /** A Reply button by words selected in one of Pi's replies, which quotes them in the next message. On by default. */
    quoteReply: true,
    /** PiP's orb by those words, beside Reply if it shows, which asks PiP about them instead. On by default. */
    askPipQuote: true,
    /** How Reply's quotes show: in the box as "fade", "tint", or "ghost", or "separate" strips over it (quote-box.js). */
    quoteStyle: "fade",
    /**
     * Going back to a session that changed while this tab was away: wait behind the loading screen until its updates
     * come, then show it whole. Off, the tab's copy of it shows at once and the updates slide in (`holdsFor` in store.js).
     */
    waitForUpdates: false,
    /** The sidebar's width in pixels, as its edge was last dragged (264 to 524); a double click on the edge resets it. */
    sidebarWidth: 312,
};

/**
 * What the one look fixes, which code elsewhere still reads: tiled windows (separate cards with gaps), the system's
 * motion, the usual spacing and widths, no session tabs, and every slot in the app's own order.
 */
const FIXED = {
    tiling: true,
    motion: "auto",
    density: "comfortable",
    width: "comfortable",
    sessionTabs: false,
    layout: {},
};

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");

        return value ?? fallback;
    } catch {
        return fallback;
    }
}

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
const lightQuery = matchMedia("(prefers-color-scheme: light)");

/** This browser's own choices, of the ones there are: what it saved, over the defaults. */
function saved() {
    const all = readJson(KEY, {});

    return Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, key in all ? all[key] : DEFAULTS[key]]),
    );
}

let own = saved();

store.set({ appearance: { ...own, ...FIXED }, pinned: readJson(PINNED, []) });

export const prefs = () => store.state.appearance;

export function setPrefs(patch) {
    own = {
        ...own,
        ...Object.fromEntries(Object.entries(patch).filter(([key]) => key in DEFAULTS)),
    };
    localStorage.setItem(KEY, JSON.stringify(own));
    store.set({ appearance: { ...own, ...FIXED } });
    apply();
}

// ─── Pinned sessions (this browser) ──────────────────────────────────────────────

/** The pinned ids as a set, made again only when the list changes: rows ask for each session as they draw. */
let pinnedSet = { list: null, set: new Set() };

export function isPinned(id) {
    const list = store.state.pinned;

    if (pinnedSet.list !== list) {
        pinnedSet = { list, set: new Set(list) };
    }

    return pinnedSet.set.has(id);
}

export function togglePin(id) {
    const pinned = isPinned(id)
        ? store.state.pinned.filter((each) => each !== id)
        : [...store.state.pinned, id];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

export function movePin(id, last) {
    if (!isPinned(id)) {
        return;
    }

    const others = store.state.pinned.filter((each) => each !== id);
    const pinned = last ? [...others, id] : [id, ...others];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

// ─── The look ───────────────────────────────────────────────────────────────────

/** Light or dark, as Appearance's Mode and the system say. */
export function modeNow() {
    const mode = prefs().mode;

    if (mode === "light" || mode === "dark") {
        return mode;
    }

    return lightQuery.matches ? "light" : "dark";
}

/** The look in use, in words, for the menu's Appearance row and the home screen: "Dark", or "System · light". */
export function lookLabel() {
    const now = modeNow() === "light" ? "light" : "dark";

    return prefs().mode === "system" ? `System · ${now}` : now === "light" ? "Light" : "Dark";
}

/** The palette in use. */
export const paletteOf = () => ({ id: "claude", name: "Claude", colors: PALETTES[modeNow()] });

export const modeOf = (palette) => (palette.colors.mode === "light" ? "light" : "dark");

/** CSS variables for a palette. Everything else in style.css mixes from these. */
export function themeVars(palette) {
    const c = palette.colors;

    return {
        "--o-bg": c.background,
        "--o-bg-dark": c.dark_background,
        "--o-bg-darker": c.darker_background,
        "--o-bg-light": c.lighter_background,
        "--o-fg": c.foreground,
        "--o-fg-dim": c.dark_foreground,
        "--o-fg-light": c.light_foreground,
        "--o-fg-bright": c.bright_foreground,
        "--o-accent": c.accent,
        "--o-selection": c.selection,
        "--o-red": c.red,
        "--o-yellow": c.yellow,
        "--o-orange": c.orange,
        "--o-green": c.green,
        "--o-cyan": c.cyan,
        "--o-blue": c.blue,
        "--o-magenta": c.magenta,
    };
}

/** Variables as an inline style. */
export const varsStyle = (vars) =>
    Object.entries(vars)
        .map(([name, value]) => `${name}:${value}`)
        .join(";");

/** Put a palette's variables in the palette layer (index.html declares the layers), over the app's defaults. */
function setPalette(vars) {
    let style = document.getElementById("pocket-palette");

    if (style === null) {
        style = document.createElement("style");
        style.id = "pocket-palette";
        document.head.append(style);
    }

    const text = `@layer palette{:root{${varsStyle(vars)}}}`;

    if (style.textContent !== text) {
        style.textContent = text;
    }
}

/** The motion on the page: the system's reduced motion, else the app's usual. */
export function motionLevel() {
    return reduceQuery.matches ? "reduced" : "full";
}

/** The sidebar's width for `--sidebar-w`, kept in range. */
const sidebarWidth = (p) => `${Math.min(524, Math.max(264, Number(p.sidebarWidth) || 312))}px`;

/** Put the current look on the page: variables, mode, and the switches style.css reads from data attributes. */
export function apply() {
    const root = document.documentElement;
    const p = prefs();
    const palette = paletteOf();
    const vars = themeVars(palette);

    setPalette(vars);
    root.style.setProperty("--text-size", `${textSizeOf(p.text)}px`);
    root.style.setProperty("--sidebar-w", sidebarWidth(p));

    const attrs = {
        mode: modeOf(palette),
        theme: "pocket",
        colors: palette.id,
        tiling: "on",
        motion: motionLevel(),
        rail: "off",
        density: "comfortable",
        width: "comfortable",
    };

    Object.assign(root.dataset, attrs);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--o-bg"]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", attrs.mode);
    applyIcons(vars);
    localStorage.setItem(
        CACHE,
        JSON.stringify({
            mode: p.mode,
            text: `${textSizeOf(p.text)}px`,
            sidebar: sidebarWidth(p),
            pair: Object.fromEntries(
                ["light", "dark"].map((mode) => {
                    const each = themeVars({ colors: PALETTES[mode] });

                    return [mode, { palette: each, color: each["--o-bg"] }];
                }),
            ),
        }),
    );
}

let started = false;

/** Put the look on the page, and follow the system's light or dark and reduced motion from now on. */
export function startTheme() {
    apply();

    if (started) {
        return;
    }

    started = true;
    reduceQuery.addEventListener?.("change", apply);
    lightQuery.addEventListener?.("change", apply);
    onSafeModeEnd(apply);
    // Once signed in: the icon's colors go to the server for requests that carry no cookie.
    const stop = store.subscribe((state) => {
        if (!state.me) {
            return;
        }

        stop();
        reportIconsAs(state.me.role === "owner");
    });
}
