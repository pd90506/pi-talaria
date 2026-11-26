/**
 * The data format this code writes, for releases (`releases.ts`): which releases can run on the data after this one.
 * Keep each value a plain number on its own `export const` line: the launcher reads them from a release's files.
 *
 * Change stored data in two releases, never one (expand, then contract; AGENTS.md):
 *
 * - **Expand**: add the new shape beside the old, and keep reading both. Older code still reads the data. Raise
 *   `DATA_VERSION` and leave `READABLE_FROM` as it is.
 * - **Contract**, a later release: stop writing (or remove) the old shape. Code before the expand cannot read the
 *   data any more: raise `DATA_VERSION`, and set `READABLE_FROM` to the expand's version.
 *
 * A release is refused when the data has moved past what it reads, unless the database goes back to a copy from
 * before (`preflight` in `releases.ts`).
 */

/** The version of the data this code writes. */
export const DATA_VERSION = 1;

/** The oldest `DATA_VERSION` whose code can read what this code writes. 0: releases from before these declarations. */
export const READABLE_FROM = 0;
