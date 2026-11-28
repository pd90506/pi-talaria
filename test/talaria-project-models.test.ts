// A project's model settings (`talaria-project-models.ts`): what `project.json` keeps, what the form may send, and
// which model a new thread starts on.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    checkProjectModels,
    parseProjectModels,
    threadChoice,
} from "../src/server/talaria-project-models.ts";

test("project.json keeps only good model entries", () => {
    assert.equal(parseProjectModels(undefined), undefined);
    assert.equal(parseProjectModels({ threads: { model: "no-slash" } }), undefined);
    assert.deepEqual(
        parseProjectModels({
            coordinator: { model: "p/a", thinking: "medium" },
            threads: { model: "p/b", thinking: "loud" },
        }),
        { coordinator: { model: "p/a", thinking: "medium" }, threads: { model: "p/b" } },
    );
});

test("the form sends known models and levels they have", () => {
    const levelsOf = (spec: string) => (spec === "p/a" ? ["off", "low", "medium"] : undefined);

    assert.deepEqual(checkProjectModels({ coordinator: null }, levelsOf), {});
    assert.deepEqual(
        checkProjectModels({ threads: { model: "p/a", thinking: "medium" } }, levelsOf),
        { threads: { model: "p/a", thinking: "medium" } },
    );
    assert.throws(() => checkProjectModels({ threads: { model: "p/x" } }, levelsOf), /not known/);
    assert.throws(
        () => checkProjectModels({ threads: { model: "p/a", thinking: "max" } }, levelsOf),
        /thinking levels off, low, medium/,
    );
});

test("a thread starts on the coordinator's choice for it, else the project's default", () => {
    const models = { threads: { model: "p/a", thinking: "low" } };

    assert.deepEqual(threadChoice(undefined, {}), { named: false });
    assert.deepEqual(threadChoice(models, {}), { model: "p/a", thinking: "low", named: false });
    assert.deepEqual(threadChoice(models, { thinking: "high" }), {
        model: "p/a",
        thinking: "high",
        named: false,
    });
    assert.deepEqual(threadChoice(models, { model: "p/b" }), { model: "p/b", named: true });
});
