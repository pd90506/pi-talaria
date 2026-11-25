// Appearance: light or dark, the conversation's text size, and how the app shows the conversation.
import { useEffect, useState } from "preact/hooks";
import { closeSheet, openSheet } from "../store.js";
import { MAX_TEXT, MIN_TEXT, prefs, setPrefs, STEP_TEXT, textSizeOf } from "../theme.js";
import { html, Icon, Sheet, Switch } from "../ui.js";
import { pipAvailable } from "../pip.js";
import { QUOTE_STYLES, quoteStyleOf } from "../quote-box.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/**
 * The conversation's text size: a few usual sizes, and a field for any other, MIN_TEXT to MAX_TEXT in half pixels. The
 * field takes a size once it is one (14 on the way to 145 shows at once); Enter or leaving it keeps it in range.
 */
function TextSize({ size }) {
    const [draft, setDraft] = useState(null);

    // A size set another way (a button, another tab) shows at once, over what was being typed; what is being typed
    // stays while it means this size.
    useEffect(() => {
        if (draft !== null && textSizeOf(draft) !== size) {
            setDraft(null);
        }
    }, [size]);

    const commit = (value) => {
        setDraft(null);
        setPrefs({ text: textSizeOf(value) });
    };

    return html`<div class="text-size" role="group" aria-label="Text size">
        <div class="segmented">
            ${[13, 15, 17, 20].map(
                (each) => html`<button
                    class=${size === each ? "on" : ""}
                    aria-pressed=${size === each}
                    onClick=${() => commit(each)}
                >
                    ${each}
                </button>`,
            )}
        </div>
        <label class="text-size-field">
            <input
                type="number"
                inputmode="decimal"
                min=${MIN_TEXT}
                max=${MAX_TEXT}
                step=${STEP_TEXT}
                aria-label="Text size in pixels"
                value=${draft ?? size}
                onInput=${(event) => {
                    const value = event.currentTarget.value;
                    const number = Number(value);

                    setDraft(value);

                    if (value !== "" && number >= MIN_TEXT && number <= MAX_TEXT) {
                        setPrefs({ text: textSizeOf(number) });
                    }
                }}
                onChange=${(event) =>
                    commit(event.currentTarget.value === "" ? size : event.currentTarget.value)}
                onBlur=${() => setDraft(null)}
                onKeyDown=${(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
            <span>px</span>
        </label>
    </div>`;
}

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

export function AppearanceSheet() {
    const p = prefs();

    return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
        <div class="label">Look</div>
        <div class="sheet-list">
            <${SettingRow} title="Mode" detail="System follows your system's light or dark">
                <div class="segmented">
                    ${[
                        ["system", "System"],
                        ["light", "Light"],
                        ["dark", "Dark"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.mode === value ? "on" : ""}
                                aria-pressed=${p.mode === value}
                                onClick=${() => setPrefs({ mode: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            ${
                pipAvailable() &&
                html`<${SettingRow}
                    title="PiP"
                    detail="Board: its conversation in the session's place, with every step and its menu. Floating: a window in the corner, or a sheet on a phone"
                >
                    <div class="segmented">
                        ${[
                            ["board", "Board"],
                            ["floating", "Floating"],
                        ].map(
                            ([value, label]) =>
                                html`<button
                                    class=${p.pip === value ? "on" : ""}
                                    aria-pressed=${p.pip === value}
                                    onClick=${() => setPrefs({ pip: value })}
                                >
                                    ${label}
                                </button>`,
                        )}
                    </div>
                <//>`
            }
            <${SettingRow}
                title="Text size"
                detail=${`The conversation's, in pixels: any from ${MIN_TEXT} to ${MAX_TEXT}`}
            >
                <${TextSize} size=${textSizeOf(p.text)} />
            <//>
        </div>
        <div class="label">Conversation</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Show thinking"
                detail=${`Shows Pi's current thought above the live line as it comes, and its finished thoughts. The chevron before the line folds the live one${touch ? "" : ". Also Alt+T"}`}
            >
                <${Switch}
                    on=${p.showThinking}
                    label="Show thinking"
                    onChange=${() => setPrefs({ showThinking: !p.showThinking })}
                />
            <//>
            <${SettingRow}
                title="Keep activity folded"
                detail="Pi's thinking and tool calls stay on their one line until you open them, also while it works and in the newest turn"
            >
                <${Switch}
                    on=${p.foldActivity}
                    label="Keep activity folded"
                    onChange=${() => setPrefs({ foldActivity: !p.foldActivity })}
                />
            <//>
            <${SettingRow}
                title="Reply to a passage"
                detail="Select words in one of Pi's replies, and a Reply button by them quotes them in your next message"
            >
                <${Switch}
                    on=${p.quoteReply}
                    label="Reply to a passage"
                    onChange=${() => setPrefs({ quoteReply: !p.quoteReply })}
                />
            <//>
            ${
                p.quoteReply &&
                html`<${SettingRow}
                    title="Quotes in the message box"
                    detail="How a passage you reply to shows. In the box, with your words: Fade, a tint that fades out to the right; Tint, a soft block; Ghost, faded words only. Separate: each in a strip over the box, sent first"
                >
                    <div class="segmented">
                        ${QUOTE_STYLES.map(
                            ([value, label]) =>
                                html`<button
                                    class=${quoteStyleOf(p) === value ? "on" : ""}
                                    aria-pressed=${quoteStyleOf(p) === value}
                                    onClick=${() => setPrefs({ quoteStyle: value })}
                                >
                                    ${label}
                                </button>`,
                        )}
                    </div>
                <//>`
            }
            ${
                pipAvailable() &&
                html`<${SettingRow}
                    title="Ask PiP about a passage"
                    detail="Select words in one of Pi's replies, and PiP's orb by them asks PiP about them, and tells it which session they came from"
                >
                    <${Switch}
                        on=${p.askPipQuote}
                        label="Ask PiP about a passage"
                        onChange=${() => setPrefs({ askPipQuote: !p.askPipQuote })}
                    />
                <//>`
            }
            <${SettingRow}
                title="Wait for updates"
                detail="Going back to a session that changed while you were away: show it once its updates have come, instead of your last copy at once with the updates sliding in"
            >
                <${Switch}
                    on=${p.waitForUpdates}
                    label="Wait for updates"
                    onChange=${() => setPrefs({ waitForUpdates: !p.waitForUpdates })}
                />
            <//>
        </div>
        <div class="label">Status line</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Reply speed"
                detail="Under the message box: how fast the last answer came, in tokens a second, and how long its first token took"
            >
                <${Switch}
                    on=${p.speed}
                    label="Reply speed"
                    onChange=${() => setPrefs({ speed: !p.speed })}
                />
            <//>
        </div>
        ${
            !touch &&
            html`<button
                class="button ghost wide sheet-footer"
                onClick=${() => openSheet({ type: "shortcuts" })}
            >
                <${Icon} name="keyboard" size=${16} /> Keyboard shortcuts
            </button>`
        }
    <//>`;
}
