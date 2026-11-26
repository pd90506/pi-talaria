/**
 * Sandbox mode: a dev instance of pi-talaria, run from a thread's worktree on a copy of the real data
 * (`main.ts --sandbox`). It must not act outside itself: whatever the copy holds was the real server's to do.
 *
 * - Schedules, triggers (PR watches, repository watches, webhooks) and Relay are off, whatever the copied settings say:
 *   scheduled messages wait, watches wait, webhooks answer 503, and no chat service is reached.
 * - Push notifications are off: the copied subscriptions are the owner's real phones.
 * - Work the copy caught under way (a run, a compaction, a queued message) is stopped before anything runs, so a turn of
 *   the real server does not go on twice. Background commands it lists belong to the real server's processes: the
 *   sandbox only counts a process as a task's when it carries the sandbox's own marker (`processes.ts`), so it never
 *   signals them.
 * - Releases are not managed from it, and the app shows a DEV banner.
 */
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";

/** Built-in modules that reach outside the app by themselves: always off in a sandbox. */
export const SANDBOX_OFF: ReadonlySet<string> = new Set([
    "schedules.ts",
    "triggers.ts",
    "pocket-relay.ts",
    // A dev instance starts none of its own.
    "dev-instances.ts",
]);

/**
 * The label of `--sandbox LABEL` or PI_TALARIA_SANDBOX: undefined for no sandbox (unset, empty, `0`, `false`), "" for a
 * sandbox without a label (`1`, `true`).
 */
export function sandboxLabel(value: string | undefined): string | undefined {
    const label = value?.trim() ?? "";
    const lower = label.toLowerCase();

    if (label === "" || lower === "0" || lower === "false") {
        return undefined;
    }

    return lower === "1" || lower === "true" ? "" : label.slice(0, 40);
}

/** A module's choice in a sandbox: the ones that reach outside are off, the rest as the settings say. */
export function sandboxChoice(
    choice: (file: string) => boolean | undefined,
): (file: string) => boolean | undefined {
    return (file) => (SANDBOX_OFF.has(file) ? false : choice(file));
}

/**
 * Stop the work the copied data caught under way, before the harness runs anything: each ordinary task a conversation
 * owns (a run, a compaction) gets its abort mark, which its abort handler honours once tasks run, and queued messages
 * are withdrawn. Background tasks (a command's watch, a schedule's wait) are left: the modules above that would act
 * on them are off, and a command's watch finds none of its processes. Returns how many it stopped.
 */
export async function quietCopy(
    harness: Pick<Harness, "inspect" | "abortTask" | "abortSubmission">,
    context: Context,
): Promise<number> {
    const inspection = await harness.inspect(context);
    let stopped = 0;

    for (const submission of inspection.submissions) {
        const result = await harness
            .abortSubmission(submission.id, context)
            .catch(() => "not_found" as const);

        if (result === "aborted") {
            stopped++;
        }
    }

    for (const { record } of inspection.tasks) {
        if (record.owner !== undefined || record.background || record.abortRequested) {
            continue;
        }

        const result = await harness.abortTask(record.id, context).catch(() => "terminal" as const);

        if (result === "marked") {
            stopped++;
        }
    }

    return stopped;
}
