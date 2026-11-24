// Steady colors: the same color for the same person or folder everywhere, and initials for a mark.

// The theme's own colors, so people keep their colors in every theme and each one fits it.
const COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-yellow)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-red)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

/** Folders' colors: the same, without yellow and red, which mark sessions waiting for you and subagents that failed. */
const FOLDER_COLORS = [
    "var(--o-blue)",
    "var(--o-green)",
    "var(--o-magenta)",
    "var(--o-cyan)",
    "var(--o-orange)",
    "var(--o-fg-bright)",
];

function hashOf(text) {
    let hash = 0;

    for (const char of String(text)) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash;
}

/** A steady color per person, so the same person looks the same on every device. */
export function personColor(id) {
    return COLORS[hashOf(id) % COLORS.length];
}

/** Each folder's color, by path: the list asks for every row as it draws, and a few folders hold most sessions. */
const folderColors = new Map();

/** A steady color per folder, from its last part, for the mark on its sessions' rows. */
export function folderColor(path) {
    const key = String(path ?? "");
    let color = folderColors.get(key);

    if (color === undefined) {
        const name = key.replace(/\/+$/, "").split("/").pop();

        color = FOLDER_COLORS[hashOf(name) % FOLDER_COLORS.length];
        folderColors.set(key, color);
    }

    return color;
}

/** "Tanner - Mac" → "TM", "alex" → "AL". */
export function initials(name) {
    const words = String(name ?? "?")
        .trim()
        .split(/[\s\-_.]+/)
        .filter(Boolean);
    const first = words[0] ?? "?";

    return (first[0] + (words.length > 1 ? words[1][0] : (first[1] ?? ""))).toUpperCase();
}
