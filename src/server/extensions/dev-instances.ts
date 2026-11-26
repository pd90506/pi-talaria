/**
 * Dev instances (`dev-instances.ts`): Pi starts pi-talaria from the session's worktree in sandbox mode, on a copy of the
 * real data, to try a change before it is merged; the owner opens it at its own tailnet address. Owner only.
 */
import { bool, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type DevInstance, repositoryRoot } from "../dev-instances.ts";
import type { PocketHost } from "../host.ts";
import { literal } from "../tool-schema.ts";

export const DEV_INSTANCES_EXTENSION = "dev-instances";

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** An instance in a few lines, as Pi reads it. */
export function describeDev(instance: DevInstance): string {
    const where = instance.url ?? `the socket ${instance.socket} (Tailscale does not serve it)`;
    const lines = [
        `Dev instance "${instance.label}" (${instance.id}): ${instance.status}`,
        `  from ${instance.worktree}${instance.commit ? ` at ${instance.commit.slice(0, 12)}` : ""}`,
    ];

    if (instance.status === "running") {
        lines.push(`  open: ${where}`);
    }

    if (instance.error !== undefined) {
        lines.push(`  ${instance.error}`);
    }

    return lines.join("\n");
}

export default function createDevInstances(host: PocketHost) {
    const devInstance = defineTool({
        name: "dev_instance",
        description:
            "Run pi-talaria from this session's checkout or worktree as a dev instance: a sandbox on a copy of the real data (schedules, triggers, Relay, and push are off in it, and nothing it does reaches the real server), at a tailnet address of its own, so the owner can try a change before it is merged and released. " +
            "Actions: start (or restart it, after you change the code; fresh: copy the real data again), stop, status (all of them), logs (the end of its server log). Commit or save the change first; the instance runs the files as they are. At most 3 run at once. The owner's only.",
        parameters: obj(
            {
                action: union([
                    literal("start"),
                    literal("restart"),
                    literal("stop"),
                    literal("status"),
                    literal("logs"),
                ]),
                label: opt(
                    str({ description: "start: a short name the app shows in its DEV band" }),
                ),
                fresh: opt(bool({ description: "start/restart: copy the real data again" })),
                folder: opt(
                    str({
                        description:
                            "the checkout to run; default this session's folder's repository",
                    }),
                ),
            },
            { open: true },
        ),
        // A start that ran already restarts the same instance; status and logs only read; stopping twice is once.
        replay: "safe",
        execute: async (args, api) => {
            const dev = host.devInstances();

            if (dev === undefined) {
                return reply(
                    "Dev instances are not available here (this is a dev instance itself).",
                );
            }

            const requester = host.requesterOf(api.conversationId);

            if (requester === undefined || host.roleOf(requester) !== "owner") {
                return reply("Only the owner's work may start or stop dev instances.");
            }

            if (args.action === "status") {
                const list = dev.list();

                return reply(
                    list.length === 0
                        ? "No dev instances."
                        : list.map((each) => describeDev(each)).join("\n\n"),
                );
            }

            const folder = args.folder ?? (await repositoryRoot(host.cwdOf(api.conversationId)));

            if (folder === undefined) {
                return reply(
                    "This session's folder is in no git repository: say which folder to run.",
                );
            }

            if (args.action === "logs") {
                const found = dev.get(folder);

                return reply(
                    found === undefined
                        ? "No dev instance runs from this folder."
                        : dev.logs(found.id) || "Its log is empty.",
                );
            }

            if (args.action === "stop") {
                const found = dev.get(folder);

                if (found === undefined) {
                    return reply("No dev instance runs from this folder.");
                }

                return reply(describeDev(await dev.stop(found.id)));
            }

            const started = await dev.start(folder, {
                ...(args.label === undefined ? {} : { label: args.label }),
                ...(args.fresh === undefined ? {} : { fresh: args.fresh }),
            });

            return reply(describeDev(started));
        },
    });

    return defineExtension({
        name: DEV_INSTANCES_EXTENSION,
        tools: [devInstance],
    });
}
