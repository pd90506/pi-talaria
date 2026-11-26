/**
 * The commands for release slots (`src/server/releases.ts`), which work when the app does not:
 *
 *   pi-pocket versions [--data DIR]
 *   pi-pocket rollback [ID] [--data DIR]
 *   pi-pocket release install [--from REPO] [--ref REF] [--switch] [--data DIR]
 *
 * `rollback` and `release install --switch` change the current slot and ask a running launcher to restart its server,
 * which then starts from the new slot. They start no server themselves.
 */
import { fileURLToPath } from "node:url";
import { readRunning } from "./desktop.ts";
import { dataDirFrom } from "./data-dir.ts";
import {
    installSlot,
    listSlots,
    pointedSlot,
    pruneSlots,
    readLedger,
    setCurrent,
    slotOf,
} from "../server/releases.ts";

const HELP = `Release slots: the versions of pi-talaria this data folder keeps.

  pi-pocket versions [--data DIR]
      List the installed releases, which one runs, and the latest changes.
  pi-pocket rollback [ID] [--data DIR]
      Go back to release ID (the previous one when not given) and restart a running server.
  pi-pocket release install [--from REPO] [--ref REF] [--switch] [--data DIR]
      Install commit REF (HEAD when not given) of the git checkout REPO (this code's folder when not given)
      as a release. --switch makes it the current one and restarts a running server.`;

const argv = process.argv.slice(2);
const data = dataDirFrom(argv);

/** The value after `name`, or undefined. */
function option(name: string): string | undefined {
    const at = argv.indexOf(name);

    return at === -1 ? undefined : argv[at + 1];
}

/** The arguments that are not options or their values. */
function positional(): string[] {
    const out: string[] = [];

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;

        if (arg === "--switch" || arg === "-h" || arg === "--help") {
            continue;
        }

        if (arg.startsWith("--")) {
            index++;
            continue;
        }

        out.push(arg);
    }

    return out;
}

function time(at: number): string {
    return new Date(at).toLocaleString();
}

/** Ask a running launcher to restart its server, which starts from the current slot. */
function restartRunning(): void {
    const running = readRunning(data);

    if (running === undefined) {
        console.log("No server runs on this data folder: the release starts at its next start.");

        return;
    }

    if (process.platform === "win32") {
        console.log(`Restart pi-talaria (launcher ${running.pid}) to start the release.`);

        return;
    }

    try {
        process.kill(running.pid, "SIGUSR2");
        console.log(`Asked the launcher (${running.pid}) to restart its server.`);
    } catch (error) {
        console.log(`Could not reach the launcher (${running.pid}): ${(error as Error).message}.`);
    }
}

function versions(): void {
    const current = pointedSlot(data, "current");
    const previous = pointedSlot(data, "previous");
    const slots = listSlots(data);

    if (slots.length === 0) {
        console.log(`No releases in ${data}. pi-talaria runs from its folder.`);

        return;
    }

    console.log("Releases:");

    for (const slot of slots) {
        const mark =
            slot.id === current ? "* current " : slot.id === previous ? "  previous" : "          ";

        console.log(
            `${mark}  ${slot.id}  ${slot.version.padEnd(8)}  ${slot.source}  installed ${time(slot.installedAt)}`,
        );
    }

    const ledger = readLedger(data, 15);

    if (ledger.length > 0) {
        console.log("\nLatest changes:");

        for (const entry of ledger) {
            const from = entry.from === undefined ? "" : ` from ${entry.from}`;
            const note = entry.note === undefined ? "" : ` (${entry.note})`;

            console.log(
                `  ${time(entry.at)}  ${entry.event} ${entry.slot}${from} by ${entry.by}${note}`,
            );
        }
    }
}

function rollback(): void {
    const target = positional()[1] ?? pointedSlot(data, "previous");

    if (target === undefined) {
        console.error(
            "There is no previous release to go back to. Name one: pi-pocket versions lists them.",
        );
        process.exitCode = 1;

        return;
    }

    const { from } = setCurrent(data, target, "cli", "rollback");

    console.log(`Release ${target} is current${from === undefined ? "" : ` (was ${from})`}.`);
    restartRunning();
}

function install(): void {
    const repo = option("--from") ?? fileURLToPath(new URL("../..", import.meta.url));
    const running = readRunning(data);
    const info = installSlot(data, {
        repo,
        ...(option("--ref") === undefined ? {} : { ref: option("--ref")! }),
        by: "cli",
    });

    console.log(`Installed release ${info.id} (${info.version}, ${info.source}).`);

    if (argv.includes("--switch")) {
        const { from } = setCurrent(data, info.id, "cli");

        console.log(`Release ${info.id} is current${from === undefined ? "" : ` (was ${from})`}.`);
        restartRunning();
    }

    const launcherSlot = running?.appRoot === undefined ? undefined : slotOf(running.appRoot);
    const removed = pruneSlots(
        data,
        undefined,
        launcherSlot === undefined ? [] : [launcherSlot],
        "cli",
    );

    if (removed.length > 0) {
        console.log(`Removed old releases: ${removed.join(", ")}.`);
    }
}

try {
    const [command, sub] = positional();

    if (argv.includes("-h") || argv.includes("--help")) {
        console.log(HELP);
    } else if (command === "versions") {
        versions();
    } else if (command === "rollback") {
        rollback();
    } else if (command === "release" && sub === "install") {
        install();
    } else {
        console.error(HELP);
        process.exitCode = 2;
    }
} catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
}
