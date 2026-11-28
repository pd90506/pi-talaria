/** A project's model settings in `project.json`: the coordinator's model and level, and the default for its threads. */

/** One choice: `provider/modelId`, and a thinking level (left out: the model's remembered or the session's). */
export type ModelChoice = { model: string; thinking?: string };

/** What `models` in `project.json` holds. */
export type ProjectModels = { coordinator?: ModelChoice; threads?: ModelChoice };

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** One choice as stored, or undefined when it is not one: a bad entry counts as not set. */
function choiceOf(value: unknown): ModelChoice | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const { model, thinking } = value as Record<string, unknown>;

    if (typeof model !== "string" || model.indexOf("/") <= 0) {
        return undefined;
    }

    return {
        model: model.trim(),
        ...(typeof thinking === "string" && LEVELS.includes(thinking) ? { thinking } : {}),
    };
}

/** The `models` of a parsed `project.json`, keeping only good entries; undefined when none is. */
export function parseProjectModels(value: unknown): ProjectModels | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const { coordinator, threads } = value as Record<string, unknown>;
    const parsed: ProjectModels = {
        ...(choiceOf(coordinator) === undefined ? {} : { coordinator: choiceOf(coordinator)! }),
        ...(choiceOf(threads) === undefined ? {} : { threads: choiceOf(threads)! }),
    };

    return Object.keys(parsed).length === 0 ? undefined : parsed;
}

/** The levels a model has, or undefined when the model is not known here. */
export type LevelsOf = (spec: string) => readonly string[] | undefined;

/**
 * Check what the settings form sent: each role is `null` (not set) or `{ model, thinking? }` with a known model and a
 * level that model has. Returns the settings to store, or throws words for the person.
 */
export function checkProjectModels(
    body: Record<string, unknown>,
    levelsOf: LevelsOf,
): ProjectModels {
    const out: ProjectModels = {};

    for (const role of ["coordinator", "threads"] as const) {
        const given = body[role];

        if (given === undefined || given === null) {
            continue;
        }

        if (typeof given !== "object" || Array.isArray(given)) {
            throw new Error(`${role} is null or { model, thinking }.`);
        }

        const { model, thinking } = given as Record<string, unknown>;

        if (typeof model !== "string" || model.trim() === "") {
            throw new Error(`${role}: choose a model.`);
        }

        const levels = levelsOf(model.trim());

        if (levels === undefined) {
            throw new Error(`${role}: the model ${model} is not known here.`);
        }

        if (thinking !== undefined && thinking !== null && thinking !== "") {
            if (typeof thinking !== "string" || !levels.includes(thinking)) {
                throw new Error(
                    `${role}: ${model} has the thinking levels ${levels.join(", ")}, not ${String(thinking)}.`,
                );
            }
        }

        out[role] = {
            model: model.trim(),
            ...(typeof thinking === "string" && thinking !== "" ? { thinking } : {}),
        };
    }

    return out;
}

/**
 * The model and level a new thread starts on: the coordinator's own choice for it first, then the project's default for
 * threads. A level alone keeps the default model. Undefined fields: as the coordinator runs.
 */
export function threadChoice(
    models: ProjectModels | undefined,
    asked: { model?: string; thinking?: string },
): { model?: string; thinking?: string; named: boolean } {
    const model = asked.model?.trim() || undefined;

    if (model !== undefined) {
        return { model, ...(asked.thinking ? { thinking: asked.thinking } : {}), named: true };
    }

    const base = models?.threads;
    const thinking = asked.thinking || base?.thinking;

    return {
        ...(base === undefined ? {} : { model: base.model }),
        ...(thinking ? { thinking } : {}),
        named: false,
    };
}
