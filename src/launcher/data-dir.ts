/** The data folder as the launcher reads it, for code that runs before its options are parsed. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `--data DIR`, then `PI_POCKET_DIR`, then `~/.pi-pocket`, as `options.ts` reads them. */
export function dataDirFrom(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
    const at = argv.indexOf("--data");

    if (at !== -1 && argv[at + 1] !== undefined) {
        return resolve(argv[at + 1]!);
    }

    return resolve(env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket"));
}
