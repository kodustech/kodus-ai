import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeVerdict, priorityOf, unverifiedP0 } from "../verdict.js";
import type { ScenarioResult, SkipKind } from "../types.js";

function result(
    scenarioId: string,
    status: ScenarioResult["status"],
    skipKind?: SkipKind,
): ScenarioResult {
    return {
        scenarioId,
        cell: { target: "cloud", provider: "github", license: "paid" },
        status,
        skipKind,
        durationMs: 0,
        evidence: skipKind ? { skipReason: "github-rate-limit: exhausted" } : {},
        startedAt: "2026-08-08T00:00:00Z",
        finishedAt: "2026-08-08T00:00:00Z",
    };
}

// `code-review-basic` is P0 in the registry; `public-pr-demo` is P1. Using
// real ids keeps this test honest about the priority lookup instead of
// stubbing it.
test("priorityOf: reads the registry, unknown ids gate", () => {
    assert.equal(priorityOf("code-review-basic"), "P0");
    assert.equal(priorityOf("public-pr-demo"), "P1");
    assert.equal(priorityOf("no-such-scenario"), "P0");
});

test("unverifiedP0: only infra skips on P0 scenarios count", () => {
    const found = unverifiedP0([
        result("code-review-basic", "skipped", "infra"), // ← the real thing
        result("code-review-basic", "skipped", "not-applicable"), // by design
        result("code-review-basic", "skipped", "setup"), // gap, but not infra
        result("public-pr-demo", "skipped", "infra"), // P1, non-gating
        result("code-review-basic", "passed"),
        result("code-review-basic", "failed"),
    ]);
    assert.equal(found.length, 1);
    assert.equal(found[0].scenarioId, "code-review-basic");
});

test("computeVerdict: green when everything applicable actually ran", () => {
    assert.equal(
        computeVerdict({
            gatingFailures: 0,
            blocked: 0,
            targetCrashed: false,
            unverifiedP0: 0,
        }),
        "green",
    );
});

// The regression this whole change exists to prevent: on 2026-08-07 five P0
// cells were skipped for GitHub quota and the run still reported a pass.
test("computeVerdict: unverified P0 coverage is INCONCLUSIVE, never green", () => {
    assert.equal(
        computeVerdict({
            gatingFailures: 0,
            blocked: 0,
            targetCrashed: false,
            unverifiedP0: 5,
        }),
        "inconclusive",
    );
});

test("computeVerdict: red beats inconclusive", () => {
    assert.equal(
        computeVerdict({
            gatingFailures: 1,
            blocked: 0,
            targetCrashed: false,
            unverifiedP0: 5,
        }),
        "red",
        "a broken gate must not be softened into 'we could not tell'",
    );
});

test("computeVerdict: blocked cells and a crashed target are red on their own", () => {
    assert.equal(
        computeVerdict({
            gatingFailures: 0,
            blocked: 2,
            targetCrashed: false,
            unverifiedP0: 0,
        }),
        "red",
    );
    assert.equal(
        computeVerdict({
            gatingFailures: 0,
            blocked: 0,
            targetCrashed: true,
            unverifiedP0: 0,
        }),
        "red",
    );
});
