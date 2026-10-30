import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    summarize,
    writeJson,
    writeMarkdown,
    type EvidenceBundle,
} from "../evidence.js";
import type { ScenarioResult } from "../types.js";

function makeResult(
    scenarioId: string,
    status: ScenarioResult["status"],
    extras: Partial<ScenarioResult> = {},
): ScenarioResult {
    return {
        scenarioId,
        cell: { target: "cloud", provider: "github", license: "paid" },
        status,
        durationMs: 1000,
        evidence: {},
        startedAt: "2026-05-14T00:00:00Z",
        finishedAt: "2026-05-14T00:00:01Z",
        ...extras,
    };
}

function makeBundle(results: ScenarioResult[]): EvidenceBundle {
    return {
        runId: "run-test",
        startedAt: "2026-05-14T00:00:00Z",
        finishedAt: "2026-05-14T00:01:00Z",
        results,
    };
}

test("summarize: counts each status", () => {
    const bundle = makeBundle([
        makeResult("a", "passed"),
        makeResult("b", "passed"),
        makeResult("c", "failed"),
        makeResult("d", "skipped", { skipKind: "not-applicable" }),
        makeResult("e", "blocked"),
    ]);
    const s = summarize(bundle);
    assert.deepEqual(s, {
        total: 5,
        passed: 2,
        failed: 1,
        skipped: 1,
        blocked: 1,
        notApplicable: 1,
        setupSkipped: 0,
        infraSkipped: 0,
        applicable: 4,
        executed: 3,
        passedOnRetry: 0,
    });
});

test("summarize: empty bundle", () => {
    const s = summarize(makeBundle([]));
    assert.deepEqual(s, {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        blocked: 0,
        notApplicable: 0,
        setupSkipped: 0,
        infraSkipped: 0,
        applicable: 0,
        executed: 0,
        passedOnRetry: 0,
    });
});

// The bug this whole breakdown exists to kill: a cell that GitHub's quota
// stopped us from checking used to be indistinguishable from a cell the
// matrix never meant to run. Same status, same number, run reported green.
test("summarize: separates infra skips from not-applicable skips", () => {
    const s = summarize(
        makeBundle([
            makeResult("a", "passed"),
            makeResult("na", "skipped", { skipKind: "not-applicable" }),
            makeResult("quota", "skipped", {
                skipKind: "infra",
                evidence: { skipReason: "github-rate-limit: …" },
            }),
            makeResult("down", "skipped", {
                skipKind: "infra",
                evidence: { skipReason: "target-unreachable: …" },
            }),
            makeResult("secret", "skipped", { skipKind: "setup" }),
        ]),
    );
    assert.equal(s.skipped, 4, "all four still count as skipped");
    assert.equal(s.notApplicable, 1);
    assert.equal(s.infraSkipped, 2, "quota + target-down are NOT verified");
    assert.equal(s.setupSkipped, 1);
    // applicable excludes only the by-design skip: 4 cells were supposed to
    // be checked, 1 actually was.
    assert.equal(s.applicable, 4);
    assert.equal(s.executed, 1);
});

test("summarize: a skip with no kind is treated as not-applicable (old artifacts)", () => {
    const s = summarize(makeBundle([makeResult("legacy", "skipped")]));
    assert.equal(s.notApplicable, 1);
    assert.equal(s.infraSkipped, 0);
});

test("summarize: counts passes that only happened on the retry", () => {
    const s = summarize(
        makeBundle([
            makeResult("solid", "passed"),
            makeResult("flaky", "passed", { flaky: true }),
        ]),
    );
    assert.equal(s.passed, 2, "a retry pass is still a pass");
    assert.equal(s.passedOnRetry, 1, "…but it is counted separately");
});

test("writeMarkdown: names the skip kind and flags retry passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-test-"));
    try {
        writeMarkdown(
            dir,
            makeBundle([
                makeResult("quota", "skipped", {
                    skipKind: "infra",
                    evidence: { skipReason: "github-rate-limit: exhausted" },
                }),
                makeResult("wobbly", "passed", { flaky: true }),
            ]),
        );
        const md = readFileSync(join(dir, "summary.md"), "utf8");
        assert.match(md, /infra: github-rate-limit/);
        assert.match(md, /passed \(on retry\)/);
        assert.match(md, /Not verified: \*\*1 infra\*\*/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writeJson: produces parseable JSON with all fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-test-"));
    try {
        const bundle = makeBundle([
            makeResult("a", "passed", { evidence: { sample: "ok" } }),
        ]);
        writeJson(dir, bundle);
        const raw = readFileSync(join(dir, "result.json"), "utf8");
        const parsed = JSON.parse(raw);
        assert.equal(parsed.runId, "run-test");
        assert.equal(parsed.results.length, 1);
        assert.equal(parsed.results[0].evidence.sample, "ok");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writeMarkdown: includes summary, table, and failure section when failures exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-test-"));
    try {
        const bundle = makeBundle([
            makeResult("ok-scenario", "passed"),
            makeResult("broken-scenario", "failed", {
                errorMessage: "auth failed",
                errorStack: "Error: auth failed\n  at line 1",
            }),
        ]);
        writeMarkdown(dir, bundle);
        const md = readFileSync(join(dir, "summary.md"), "utf8");
        assert.match(md, /Summary: 1\/2 passed/);
        assert.match(md, /ok-scenario/);
        assert.match(md, /broken-scenario/);
        assert.match(md, /## Failures/);
        assert.match(md, /auth failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writeMarkdown: skips failure section when nothing failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-test-"));
    try {
        const bundle = makeBundle([
            makeResult("a", "passed"),
            makeResult("b", "passed"),
        ]);
        writeMarkdown(dir, bundle);
        const md = readFileSync(join(dir, "summary.md"), "utf8");
        assert.match(md, /Summary: 2\/2 passed/);
        assert.ok(!md.includes("## Failures"), "should not include failure section");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
