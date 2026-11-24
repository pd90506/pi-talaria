// Sign in another device as the owner: a one-time link and code, as a QR code too.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, store } from "../store.js";
import { copyText, html, Loader, Sheet } from "../ui.js";

/** End a sign-in link nobody will see: one the sheet stopped showing, or one that answered too late to show. */
const cancelInvite = (invite) => {
    if (invite?.code === undefined) {
        return;
    }

    // Sent even when the page goes (a reload, a web file edited), so it is never left live and unseen.
    fetch("/api/invite/cancel", {
        method: "POST",
        keepalive: true,
        headers: { "X-Pocket": "1", "content-type": "application/json" },
        body: JSON.stringify({ code: invite.code }),
    }).catch(() => {});
};

export function DeviceSheet() {
    const [invite, setInvite] = useState(null);
    const [failed, setFailed] = useState(false);
    // Only the newest link shows: one asked for earlier, answering late, is ended.
    const latest = useRef(0);
    const shown = useRef(null);
    const mounted = useRef(true);
    const open = () => mounted.current && store.state.sheet?.type === "device";
    const create = () =>
        attempt(async () => {
            if (!open()) {
                return;
            }

            const ticket = ++latest.current;

            cancelInvite(shown.current);
            shown.current = null;
            setInvite(null);
            setFailed(false);
            let answer;

            try {
                answer = await api("invite", { role: "owner" });
            } catch (error) {
                if (ticket === latest.current) {
                    setFailed(true);
                }

                throw error;
            }

            if (ticket !== latest.current || !open()) {
                cancelInvite(answer);

                return;
            }

            shown.current = answer;
            setInvite(answer);
        });

    useEffect(() => {
        create();

        return () => {
            mounted.current = false;
            cancelInvite(shown.current);
        };
    }, []);

    const copy = (text, what) =>
        copyText(text).then(
            () => notify("info", `${what} copied.`),
            () => notify("error", "Could not copy."),
        );

    return html`<${Sheet} title="Sign in another device" onClose=${closeSheet}>
        <p class="muted small">
            Scan this on your other device, or send it the link. That device signs in as you. It
            works once and expires in 15 minutes.
        </p>
        ${
            invite?.access?.url &&
            html`<p class="muted small">Other devices connect through ${invite.access.label}.</p>`
        }
        ${
            invite
                ? html`<div class="invite">
                      ${
                          invite.local &&
                          html`<div class="error-box">
                              This link only works on this device. To let other devices in, start
                              the server with <span class="mono">--access</span> and pick Local
                              network, Cloudflare Tunnel, or Tailscale. Then make a new link.
                          </div>`
                      }
                      <div class="invite-details">
                          <div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
                          <div class="invite-code">
                              <div class="invite-code-head">
                                  <span>Sign-in code</span>
                                  <button class="link small" onClick=${() => copy(invite.code, "Code")}>
                                      Copy
                                  </button>
                              </div>
                              <div
                                  class="invite-code-value"
                                  aria-label=${`Sign-in code ${invite.code.split("").join(" ")}`}
                              >
                                  <span>${invite.code.slice(0, 5)}</span>
                                  <span>${invite.code.slice(5)}</span>
                              </div>
                              <div class="muted small">
                                  Or enter it on the other device's sign-in screen.
                              </div>
                          </div>
                      </div>
                      <div class="row">
                          <input
                              class="mono"
                              readonly
                              value=${invite.url}
                              onFocus=${(event) => event.currentTarget.select()}
                          />
                          <button class="button" onClick=${() => copy(invite.url, "Link")}>
                              Copy
                          </button>
                      </div>
                  </div>`
                : failed
                  ? html`<p class="muted small">No link yet. Tap New link to try again.</p>`
                  : html`<${Loader} label="Making a link" />`
        }
        <button class="button wide" onClick=${create}>New link</button>
    <//>`;
}
