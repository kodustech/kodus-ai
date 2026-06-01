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
        makeResult("d", "skipped"),
        makeResult("e", "blocked"),
    ]);
    const s = summarize(bundle);
    assert.deepEqual(s, {
        total: 5,
        passed: 2,
        failed: 1,
        skipped: 1,
        blocked: 1,
    });
});

test("summarize: empty bundle", () => {
    const s = summarize(makeBundle([]));
    assert.deepEqual(s, { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 });
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
