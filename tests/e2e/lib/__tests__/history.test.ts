import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    cellHealth,
    cellKey,
    daysSince,
    parseHistory,
    quarantineCandidates,
    runRollups,
    serializeRows,
    toHistoryRows,
    type HistoryRow,
} from "../history.js";
import type { EvidenceBundle } from "../evidence.js";
import type { ScenarioResult } from "../types.js";

const NOW = new Date("2026-08-08T12:00:00Z");
const day = (n: number) =>
    new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(over: Partial<HistoryRow> = {}): HistoryRow {
    return {
        ts: day(0),
        runId: "run-1",
        matrixId: "fast",
        target: "cloud",
        provider: "github",
        license: "paid",
        scenario: "code-review-basic",
        status: "passed",
        durationMs: 1000,
        ...over,
    };
}

function scenarioResult(over: Partial<ScenarioResult> = {}): ScenarioResult {
    return {
        scenarioId: "code-review-basic",
        cell: { target: "cloud", provider: "github", license: "paid" },
        status: "passed",
        durationMs: 1234,
        evidence: {},
        startedAt: "2026-08-08T11:00:00Z",
        finishedAt: "2026-08-08T11:30:00Z",
        ...over,
    };
}

test("toHistoryRows: flattens a bundle and carries skipKind/flaky through", () => {
    const bundle: EvidenceBundle = {
        runId: "run-x",
        startedAt: "2026-08-08T11:00:00Z",
        finishedAt: "2026-08-08T11:30:00Z",
        results: [
            scenarioResult(),
            scenarioResult({ status: "passed", flaky: true }),
            scenarioResult({ status: "skipped", skipKind: "infra" }),
        ],
    };
    const rows = toHistoryRows(bundle, {
        matrixId: "fast",
        verdict: "inconclusive",
        ref: "abc123",
        ciRunId: "999",
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].ts, "2026-08-08T11:30:00Z");
    assert.equal(rows[0].runId, "run-x");
    assert.equal(rows[0].verdict, "inconclusive");
    assert.equal(rows[0].ref, "abc123");
    assert.equal(rows[0].ciRunId, "999");
    assert.equal(rows[1].flaky, true);
    assert.equal(rows[2].skipKind, "infra");
    // absent flags must not be serialized as `false` — the log is append-only
    // and every wasted byte is permanent
    assert.equal("flaky" in rows[0], false);
});

test("serializeRows / parseHistory: round-trip", () => {
    const rows = [row(), row({ runId: "run-2" })];
    assert.deepEqual(parseHistory(serializeRows(rows)), rows);
});

test("parseHistory: survives a truncated trailing line", () => {
    const good = JSON.stringify(row());
    const parsed = parseHistory(`${good}\n{"scenario":"broken`);
    assert.equal(parsed.length, 1, "a partial write must not lose the whole log");
});

test("parseHistory: tolerates blank lines and junk", () => {
    assert.deepEqual(parseHistory("\n\n  \nnot json\n"), []);
});

test("cellKey: identity is scenario × target × provider × license", () => {
    assert.equal(
        cellKey(row()),
        "code-review-basic × cloud × github × paid",
    );
});

test("cellHealth: last-green is the newest pass, not the newest run", () => {
    const h = cellHealth(
        [
            row({ ts: day(10), status: "passed" }),
            row({ ts: day(3), status: "failed" }),
            row({ ts: day(1), status: "failed" }),
        ],
        { now: NOW },
    );
    assert.equal(h.length, 1);
    assert.equal(h[0].lastGreen, day(10));
    assert.equal(h[0].lastRun, day(1));
    assert.equal(h[0].executed, 3);
    assert.equal(h[0].failed, 2);
    assert.equal(daysSince(h[0].lastGreen, NOW), 10);
});

// not-applicable rows would otherwise drown every rate: most of the matrix is
// n/a by design, so counting them would report ~90% "healthy" no matter what.
test("cellHealth: not-applicable rows are excluded entirely", () => {
    const h = cellHealth(
        [
            row({ status: "skipped", skipKind: "not-applicable" }),
            row({ scenario: "other", status: "passed" }),
        ],
        { now: NOW },
    );
    assert.equal(h.length, 1);
    assert.equal(h[0].scenario, "other");
});

test("cellHealth: infra skips count as unverified, never as a pass", () => {
    const h = cellHealth(
        [
            row({ status: "skipped", skipKind: "infra" }),
            row({ status: "skipped", skipKind: "infra" }),
            row({ status: "passed" }),
        ],
        { now: NOW },
    );
    assert.equal(h[0].unverified, 2);
    assert.equal(h[0].executed, 1, "unverified runs are not executions");
    assert.equal(h[0].passed, 1);
});

test("cellHealth: flake rate is flaky passes over executions", () => {
    const h = cellHealth(
        [
            row({ status: "passed", flaky: true }),
            row({ status: "passed" }),
            row({ status: "passed" }),
            row({ status: "passed" }),
        ],
        { now: NOW },
    );
    assert.equal(h[0].flaky, 1);
    assert.equal(h[0].flakeRate, 0.25);
});

test("cellHealth: honors the time window", () => {
    const h = cellHealth(
        [row({ ts: day(45), status: "passed" }), row({ ts: day(2), status: "failed" })],
        { sinceDays: 30, now: NOW },
    );
    assert.equal(h[0].executed, 1);
    assert.equal(h[0].lastGreen, null, "the only pass is outside the window");
});

test("quarantineCandidates: needs enough runs before a rate means anything", () => {
    const noisyButRare = cellHealth(
        [row({ status: "failed" }), row({ status: "passed" })],
        { now: NOW },
    );
    assert.equal(
        quarantineCandidates(noisyButRare).length,
        0,
        "1 failure in 2 runs is not a pattern — quarantining it would hide a real regression",
    );

    const chronic = cellHealth(
        [
            ...Array.from({ length: 4 }, () => row({ status: "failed" })),
            ...Array.from({ length: 4 }, () => row({ status: "passed" })),
        ],
        { now: NOW },
    );
    assert.equal(quarantineCandidates(chronic).length, 1);
});

test("runRollups: one row per run, newest first, applicable excludes n/a", () => {
    const rollups = runRollups([
        row({ runId: "old", ts: day(5) }),
        row({ runId: "new", ts: day(1), status: "passed" }),
        row({
            runId: "new",
            ts: day(1),
            status: "skipped",
            skipKind: "not-applicable",
        }),
        row({ runId: "new", ts: day(1), status: "skipped", skipKind: "infra" }),
    ]);
    assert.equal(rollups.length, 2);
    assert.equal(rollups[0].runId, "new");
    assert.equal(rollups[0].total, 3);
    assert.equal(rollups[0].applicable, 2, "the n/a cell is not part of the goal");
    assert.equal(rollups[0].executed, 1);
    assert.equal(rollups[0].infraSkipped, 1);
});
