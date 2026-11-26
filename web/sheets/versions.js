// Versions: the releases of pi-talaria that this server keeps, updates from the release source, and going back
// (`src/server/release-manager.ts`, `/api/releases`). The owner's.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify } from "../store.js";
import { formatWhen, html, Loader, Sheet, timeAgo } from "../ui.js";

const short = (sha) => sha.slice(0, 7);

/** What a ledger line says, in words. */
const EVENTS = {
    install: "Installed",
    switch: "Switched to",
    rollback: "Went back to",
    prune: "Removed",
    good: "Passed its trial:",
    snapshot: "Copied the database",
};

/** A release in the list: its id, version, where it came from, and what it is now. */
function Release({ slot, status, busy, goBack }) {
    const tags = [
        slot.id === status.current && "current",
        slot.id === status.running && slot.id !== status.current && "running",
        slot.id === status.previous && "previous",
        slot.id === status.trial?.slot && "on trial",
    ].filter(Boolean);
    const current = slot.id === status.current;

    return html`<div class="version-row" key=${slot.id}>
        <span class="grow">
            <span class="mono">${short(slot.id)}</span>
            <span class="muted small"> ${slot.version} · ${slot.source}</span>
            ${tags.map((tag) => html` <span class="version-tag">${tag}</span>`)}
            <br />
            <span class="muted small">installed ${formatWhen(slot.installedAt)}</span>
        </span>
        ${
            !current &&
            status.supervised &&
            html`<button
                class="button small ghost"
                disabled=${busy}
                onClick=${() => goBack(slot.id)}
            >
                Go back to this
            </button>`
        }
    </div>`;
}

/** A dev instance (`dev-instances.ts`): what it runs, where to open it, and its buttons. */
function DevRow({ instance, act }) {
    const running = instance.status === "running";
    const starting = instance.status === "starting";

    return html`<div class="version-row" key=${instance.id}>
        <span class="grow">
            <strong>${instance.label}</strong>${" "}
            <span class="version-tag">${instance.status}</span>
            <br />
            <span class="muted small mono">${instance.worktree}</span>
            ${instance.commit && html`<span class="muted small"> · ${short(instance.commit)}</span>`}
            ${
                running &&
                instance.url &&
                html`<br /><a class="small" href=${instance.url} target="_blank" rel="noopener">
                        ${instance.url}
                    </a>`
            }
            ${instance.error && html`<br /><span class="small version-error">${instance.error}</span>`}
        </span>
        <span class="version-actions">
            <button
                class="button small ghost"
                disabled=${starting}
                onClick=${() => act("restart", instance)}
            >
                ${running ? "Restart" : "Start"}
            </button>
            ${
                (running || starting) &&
                html`<button class="button small ghost" onClick=${() => act("stop", instance)}>
                    Stop
                </button>`
            }
        </span>
    </div>`;
}

/** One line of the ledger. */
function LedgerLine({ entry }) {
    const what =
        entry.event === "snapshot"
            ? EVENTS.snapshot
            : `${EVENTS[entry.event] ?? entry.event} ${short(entry.slot)}`;

    return html`<div class="version-ledger">
        <span class="muted small">${formatWhen(entry.at)}</span>
        <span class="small">
            ${what}${entry.from ? html` <span class="muted">from ${short(entry.from)}</span>` : ""}
            <span class="muted"> · ${entry.by}</span>
            ${entry.note ? html`<br /><span class="muted">${entry.note}</span>` : ""}
        </span>
    </div>`;
}

export function VersionsSheet() {
    const [status, setStatus] = useState(null);
    const [working, setWorking] = useState("");
    const [dev, setDev] = useState(null);
    const load = () =>
        attempt(async () => {
            const [releases, instances] = await Promise.all([
                api("releases"),
                api("dev").catch(() => null),
            ]);

            setStatus(releases);
            setDev(instances);
        });

    useEffect(() => {
        load();
    }, []);

    // While the server does a step (fetching, installing, copying), show its progress.
    useEffect(() => {
        if (!status?.step) {
            return;
        }

        const timer = setInterval(load, 2000);

        return () => clearInterval(timer);
    }, [status?.step]);

    // While a dev instance starts, follow it.
    const devStarting = dev?.instances.some((each) => each.status === "starting") ?? false;

    useEffect(() => {
        if (!devStarting) {
            return;
        }

        const timer = setInterval(load, 2000);

        return () => clearInterval(timer);
    }, [devStarting]);

    const act = (what, instance) =>
        attempt(async () => {
            setDev(await api(`dev/${what}`, { id: instance.id }));
        });

    const busy = working !== "" || Boolean(status?.step);
    const run = (label, path, body = {}) =>
        attempt(async () => {
            setWorking(label);

            try {
                setStatus(await api(path, body));
            } finally {
                setWorking("");
            }
        });
    const check = () => run("Looking for updates", "releases/check");

    const update = () => {
        if (
            confirm(
                "Install the new version and restart? Running work continues after the restart. If the new version does not start or keeps failing, the app goes back to this one by itself.",
            )
        ) {
            run("Installing", "releases/update").then(() =>
                notify("info", "Restarting on the new version."),
            );
        }
    };

    const goBack = (slot) => {
        if (
            confirm(
                `Go back to release ${short(slot)} and restart? If it does not start, the app returns to the current one by itself.`,
            )
        ) {
            run("Going back", "releases/rollback", { slot }).then(() =>
                notify("info", `Restarting on release ${short(slot)}.`),
            );
        }
    };

    if (status === null) {
        return html`<${Sheet} title="Versions" onClose=${closeSheet} wide=${true}>
            <${Loader} label="Reading the releases" />
        <//>`;
    }

    const running = status.slots.find((slot) => slot.id === status.running);

    return html`<${Sheet} title="Versions" onClose=${closeSheet} wide=${true}>
        <div class="version-card">
            ${
                running
                    ? html`<div>
                          <strong>Release ${short(running.id)}</strong>
                          <span class="muted"> ${running.version} · ${running.source}</span>
                      </div>`
                    : html`<div>
                          <strong>Running from a checkout</strong>
                          <p class="muted small">
                              Nothing here is installed as a release yet. Run${" "}
                              <span class="mono">pi-pocket release install --switch</span>${" "}
                              once in the checkout.
                          </p>
                      </div>`
            }
            ${
                status.trial &&
                html`<p class="small version-trial">
                    On trial since ${timeAgo(status.trial.readyAt ?? status.trial.at)}. If it fails
                    to start, or stops twice in its first 10 minutes, the app goes back to release
                    ${" "}${short(status.trial.from)} by itself.
                </p>`
            }
            ${!status.supervised && html`<p class="muted small">Start pi-talaria with bin/pi-pocket.js to update or go back from here.</p>`}
        </div>

        ${
            status.source &&
            html`<div class="group">
                <div class="group-title">Updates</div>
                <div class="version-card">
                    <p class="muted small">
                        From <span class="mono">${status.source.url}</span> (${status.source.branch}).
                        ${status.checkedAt ? ` Looked ${timeAgo(status.checkedAt)}.` : ""}
                    </p>
                    ${
                        status.available
                            ? html`<p class="small">
                                      ${status.available.commits.length || "New"}
                                      ${status.available.commits.length === 1 ? " change" : " changes"} since
                                      this release:
                                  </p>
                                  <ul class="version-commits small">
                                      ${status.available.commits.map(
                                          (commit) => html`<li key=${commit.sha}>
                                              <span class="mono muted">${short(commit.sha)}</span>
                                              ${" "}${commit.subject}
                                          </li>`,
                                      )}
                                  </ul>`
                            : status.checkedAt &&
                              html`<p class="small">This is the newest version.</p>`
                    }
                    ${(working || status.step) && html`<${Loader} label=${status.step ?? working} />`}
                    ${status.error && html`<p class="small version-error">${status.error}</p>`}
                    <div class="version-actions">
                        <button class="button small" disabled=${busy} onClick=${check}>
                            Check for updates
                        </button>
                        ${
                            status.available &&
                            status.supervised &&
                            html`<button
                                class="button small primary"
                                disabled=${busy || Boolean(status.trial)}
                                onClick=${update}
                            >
                                Update to ${short(status.available.commit)}
                            </button>`
                        }
                    </div>
                </div>
            </div>`
        }

        ${
            status.slots.length > 0 &&
            html`<div class="group">
                <div class="group-title">Releases kept</div>
                <div class="sheet-list">
                    ${status.slots.map(
                        (slot) =>
                            html`<${Release}
                                key=${slot.id}
                                slot=${slot}
                                status=${status}
                                busy=${busy}
                                goBack=${goBack}
                            />`,
                    )}
                </div>
            </div>`
        }

        ${
            dev?.instances.length > 0 &&
            html`<div class="group">
                <div class="group-title">Dev instances</div>
                <p class="muted small">
                    pi-talaria from a worktree, on a copy of the data: schedules, triggers, Relay, and push are
                    off in them. Pi starts them with its dev_instance tool.
                </p>
                <div class="sheet-list">
                    ${dev.instances.map(
                        (instance) =>
                            html`<${DevRow} key=${instance.id} instance=${instance} act=${act} />`,
                    )}
                </div>
            </div>`
        }

        ${
            status.ledger.length > 0 &&
            html`<div class="group">
                <div class="group-title">History</div>
                <div class="sheet-list">
                    ${status.ledger.map(
                        (entry, index) => html`<${LedgerLine} key=${index} entry=${entry} />`,
                    )}
                </div>
            </div>`
        }
    <//>`;
}
