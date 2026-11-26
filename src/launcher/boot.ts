/**
 * Which launcher runs. Once pi-talaria runs from release slots (`src/server/releases.ts`), the launcher of the current
 * slot runs, whatever folder `bin/pi-pocket.js` was started from: a service that points at a checkout keeps working,
 * and nothing in that checkout runs. Without slots, this folder's launcher runs, as before. `versions`, `rollback`,
 * and `release` are the commands for the slots (`releases-cli.ts`).
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDirFrom } from "./data-dir.ts";
import { pointedSlot, slotDir, slotOf } from "../server/releases.ts";

const RELEASE_COMMANDS = new Set(["versions", "rollback", "release"]);

const here = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);

if (RELEASE_COMMANDS.has(argv[0] ?? "")) {
    await import("./releases-cli.ts");
} else {
    const data = dataDirFrom(argv);
    // PI_TALARIA_NO_SLOT=1 runs this folder's launcher and server, for a copy that must not use the slots.
    const slot = process.env.PI_TALARIA_NO_SLOT === "1" ? undefined : pointedSlot(data, "current");

    if (slot !== undefined && slotOf(here) !== slot) {
        const entry = join(slotDir(data, slot), "src", "launcher", "main.ts");

        try {
            await import(pathToFileURL(entry).href);
        } catch (error) {
            console.error(
                `The launcher of release ${slot} did not load (${(error as Error).message}); starting the one in ${here}.`,
            );
            await import("./main.ts");
        }
    } else {
        await import("./main.ts");
    }
}
