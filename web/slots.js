// Slots: places in the app built from named items, the app's own and extensions' alike, in one order that extensions can
// change. The app's items have `core:` names (`core:dock`, `core:cache`), extensions' `ext:<module>:<id>`. What shows,
// and where, comes in layers: each item's default place, then where an extension asked to put its own item (`before`,
// `after`), then what extensions arranged (`pocket.arrange`). Fixed items (the menu, the connection's warning) always show, in their
// own place.
import { Fragment, h } from "preact";

/** The slots, with their names for people and where extensions' items go by default. */
export const SLOTS = {
    topbar: { label: "Top bar buttons", extensions: 550 },
    status: { label: "Status line items", extensions: 500 },
    composer: { label: "Message box buttons", extensions: 500 },
    reply: { label: "Under Pi's answers", extensions: 500 },
};

/**
 * The app's own items, by slot: `{ id, label, order, fixed, render(context), detail(context) }`. `render` gives what
 * shows, or null when it has nothing to show now; `detail`, what a tap on the status line says of it. `context` is what
 * the place that draws the slot gives: the answer, for the actions under one.
 */
const core = new Map(Object.keys(SLOTS).map((slot) => [slot, []]));
/** Where extensions' items come from (`extension-ui.js`): `(slot) => items`, with `before` and `after` too. */
let extensionItems = () => [];
/** What extensions arranged: `(slot) => [{ module, title, hide, order }]`, in the server's order of modules. */
let extensionArrangements = () => [];
/** Counts changes to the items and arrangements above: each slot's order (`arranged`) is kept until the next. */
let version = 0;
/** Each slot's order as it was last worked out: `{ version, list, key }`. */
const kept = new Map();

/** Add one of the app's own items to a slot. */
export function defineItem(slot, item) {
    core.get(slot).push(item);
    version++;
}

/** Where extensions' items and arrangements come from: `extension-ui.js`, which imports this module. */
export function fromExtensions(items, arrangements) {
    extensionItems = items;
    extensionArrangements = arrangements;
    version++;
}

/** Extensions' items or arrangements changed: `extension-ui.js` says so as they do, before it draws them. */
export function slotsChanged() {
    version++;
}

/**
 * The items named in `ids` take the places those items had, in the order `ids` gives; the rest stay where they are. So
 * an order saved before an item came still holds, and the new item keeps its default place.
 */
function reorder(list, ids) {
    // Each id once: a list with an id twice would put one item in two places, and drop another.
    const named = [...new Set(ids)]
        .map((id) => list.find((item) => item.id === id))
        .filter(Boolean);
    const places = new Set(named);
    let next = 0;

    return list.map((item) => (places.has(item) ? named[next++] : item));
}

/** Move `item` just before or after the item named `target`, when that one is there. */
function place(list, item, target, after) {
    const rest = list.filter((each) => each !== item);
    const at = rest.findIndex((each) => each.id === target);

    if (at === -1) {
        return list;
    }

    rest.splice(after ? at + 1 : at, 0, item);

    return rest;
}

/**
 * Every item of a slot, in the order it shows: `{ item, hidden, hiddenBy }`, `hiddenBy` naming the extension that hid it.
 * Items that show nothing now (no artifacts yet, say) are here too. Worked out again only when the items or what
 * extensions arranged changed: the top bar, the message box, the status line, and each of Pi's answers ask on every draw.
 */
export function arranged(slot) {
    return keptFor(slot).list;
}

function keptFor(slot) {
    const last = kept.get(slot);

    if (last?.version === version) {
        return last;
    }

    const list = arrange(slot);
    const next = {
        version,
        list,
        key: list
            .map(({ item, hidden }) => `${item.id}${item.revision ?? ""}${hidden ? "-" : "+"}`)
            .join(),
    };

    kept.set(slot, next);

    return next;
}

function arrange(slot) {
    const defaultPlace = (item) => item.order ?? SLOTS[slot].extensions;
    let list = [...core.get(slot), ...extensionItems(slot)]
        .map((item, index) => ({ item, index }))
        .sort((a, b) => defaultPlace(a.item) - defaultPlace(b.item) || a.index - b.index)
        .map(({ item }) => item);

    for (const item of list.filter((each) => each.before || each.after)) {
        list = place(list, item, item.before ?? item.after, item.before === undefined);
    }

    // Fixed items keep their places: the rest move around them.
    const fixed = list.map((item, index) => [item, index]).filter(([item]) => item.fixed);
    const arrangements = extensionArrangements(slot);

    list = list.filter((item) => !item.fixed);

    for (const arrangement of arrangements) {
        list = reorder(list, arrangement.order ?? []);
    }

    for (const [item, index] of fixed) {
        list.splice(index, 0, item);
    }

    return list.map((item) => {
        const by = arrangements.find((each) => each.hide?.includes(item.id));

        return {
            item,
            hidden: !item.fixed && by !== undefined,
            hiddenBy: !item.fixed && by ? by.title : null,
        };
    });
}

/**
 * What a slot shows now: `{ id, node, detail }` for each item that shows and has something to show, in its order. Each
 * node keeps its item's key, so a reorder moves it rather than drawing it again.
 */
export function slotItems(slot, context = {}) {
    return arranged(slot)
        .filter(({ hidden }) => !hidden)
        .map(({ item }) => ({
            id: item.id,
            node: item.render(context),
            detail: item.detail?.(context),
        }))
        .filter(({ node }) => node !== null && node !== undefined && node !== false)
        .map(({ id, node, detail }) => ({ id, node: h(Fragment, { key: id }, node), detail }));
}

/**
 * What a slot holds and how it is arranged, as one string: for a place that draws again only when its inputs change
 * (the transcript's answers), so a change to the slot draws it again.
 */
export const slotKey = (slot) => keptFor(slot).key;
