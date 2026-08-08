import type { EvidenceBundle } from "./evidence.js";
import type { RunVerdict, ScenarioResult, SkipKind } from "./types.js";

/**
 * One durable row per scenario result.
 *
 * The matrix has always written this data — `result.json` inside a CI
 * artifact — but artifacts expire (14–30 days) and there is no way to query
 * across runs, so "when did this cell last pass?" and "which cells are
 * flaky?" had no answer. These rows are the same data flattened into an
 * append-only JSONL log that outlives the artifacts.
 *
 * Keep this shape ADDITIVE. The log is append-only and old rows are never
 * rewritten, so a reader must tolerate rows written by older code — which is
 * why every field added after v1 is optional.
 */
export interface HistoryRow {
    /** Run finish time (ISO). The time axis for every aggregation. */
    ts: string;
    runId: string;
    /** Matrix file id: fast | full | midweek-smoke | … */
    matrixId: string;
    target: string;
    provider: string;
    license: string;
    scenario: string;
    status: ScenarioResult["status"];
    skipKind?: SkipKind;
    flaky?: boolean;
    durationMs: number;
    /** Run-level verdict, denormalised so a single row explains its context. */
    verdict?: RunVerdict;
    /** Commit under test. */
    ref?: string;
    /** GitHub Actions run id, for jumping back to the logs. */
    ciRunId?: string;
}

export interface RunMeta {
    matrixId: string;
    verdict?: RunVerdict;
    ref?: string;
    ciRunId?: string;
}

/** Stable identity of a matrix cell — the unit every aggregation groups by. */
export function cellKey(
    r: Pick<HistoryRow, "scenario" | "target" | "provider" | "license">,
): string {
    return `${r.scenario} × ${r.target} × ${r.provider} × ${r.license}`;
}

export function toHistoryRows(
    bundle: EvidenceBundle,
    meta: RunMeta,
): HistoryRow[] {
    return bundle.results.map((r) => ({
        ts: bundle.finishedAt,
        runId: bundle.runId,
        matrixId: meta.matrixId,
        target: r.cell.target,
        provider: r.cell.provider,
        license: r.cell.license,
        scenario: r.scenarioId,
        status: r.status,
        ...(r.skipKind ? { skipKind: r.skipKind } : {}),
        ...(r.flaky ? { flaky: true } : {}),
        durationMs: r.durationMs,
        ...(meta.verdict ? { verdict: meta.verdict } : {}),
        ...(meta.ref ? { ref: meta.ref } : {}),
        ...(meta.ciRunId ? { ciRunId: meta.ciRunId } : {}),
    }));
}

export function serializeRows(rows: HistoryRow[]): string {
    return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/**
 * Tolerant JSONL parse: a truncated or malformed trailing line (a push that
 * raced, a partial write) must not take the whole history down — the log is
 * append-only and mostly good, so we drop the bad line and keep going.
 */
export function parseHistory(text: string): HistoryRow[] {
    const rows: HistoryRow[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const parsed = JSON.parse(t) as HistoryRow;
            if (parsed && typeof parsed.scenario === "string") rows.push(parsed);
        } catch {
            // ignore — see doc comment
        }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Aggregations. These answer the three questions the matrix could not:
//   1. When did this cell last actually pass?
//   2. Which cells are flaky, and how flaky?
//   3. How much of what we meant to check is actually running?
// ---------------------------------------------------------------------------

export interface CellHealth {
    cell: string;
    scenario: string;
    target: string;
    provider: string;
    license: string;
    /** Runs where the cell produced a real result (passed or failed). */
    executed: number;
    passed: number;
    failed: number;
    /** Passed, but only on the retry. */
    flaky: number;
    /** Skipped because infra stopped us — coverage we did not get. */
    unverified: number;
    /** ISO timestamp of the most recent pass, or null if it never passed here. */
    lastGreen: string | null;
    /** ISO timestamp of the most recent execution of any outcome. */
    lastRun: string | null;
    /** flaky / executed, 0..1. Meaningless below `minRuns` — see quarantineCandidates. */
    flakeRate: number;
    /** failed / executed, 0..1. */
    failRate: number;
}

export function cellHealth(
    rows: HistoryRow[],
    opts: { sinceDays?: number; now?: Date } = {},
): CellHealth[] {
    const now = opts.now ?? new Date();
    const cutoff = opts.sinceDays
        ? new Date(now.getTime() - opts.sinceDays * 86_400_000).toISOString()
        : null;
    const byCell = new Map<string, CellHealth>();

    for (const r of rows) {
        if (cutoff && r.ts < cutoff) continue;
        // not-applicable rows are noise here: the cell was never meant to run.
        if (r.status === "skipped" && (r.skipKind ?? "not-applicable") === "not-applicable") {
            continue;
        }
        const key = cellKey(r);
        let h = byCell.get(key);
        if (!h) {
            h = {
                cell: key,
                scenario: r.scenario,
                target: r.target,
                provider: r.provider,
                license: r.license,
                executed: 0,
                passed: 0,
                failed: 0,
                flaky: 0,
                unverified: 0,
                lastGreen: null,
                lastRun: null,
                flakeRate: 0,
                failRate: 0,
            };
            byCell.set(key, h);
        }
        if (r.status === "passed" || r.status === "failed") {
            h.executed++;
            if (!h.lastRun || r.ts > h.lastRun) h.lastRun = r.ts;
        }
        if (r.status === "passed") {
            h.passed++;
            if (r.flaky) h.flaky++;
            if (!h.lastGreen || r.ts > h.lastGreen) h.lastGreen = r.ts;
        }
        if (r.status === "failed") h.failed++;
        if (r.status === "skipped" && r.skipKind === "infra") h.unverified++;
    }

    for (const h of byCell.values()) {
        h.flakeRate = h.executed ? h.flaky / h.executed : 0;
        h.failRate = h.executed ? h.failed / h.executed : 0;
    }
    return [...byCell.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}

export function daysSince(iso: string | null, now = new Date()): number | null {
    if (!iso) return null;
    return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Cells worth quarantining: flaky (or outright failing) often enough that
 * they are no longer a trustworthy gate, with ENOUGH RUNS for the rate to
 * mean anything. Requiring `minRuns` is the whole point — one flake in one
 * run is not a pattern, and quarantining on it would hide a real regression.
 */
export function quarantineCandidates(
    health: CellHealth[],
    opts: { minRuns?: number; minFlakeRate?: number } = {},
): CellHealth[] {
    const minRuns = opts.minRuns ?? 5;
    const minFlakeRate = opts.minFlakeRate ?? 0.3;
    return health
        .filter(
            (h) =>
                h.executed >= minRuns &&
                h.flakeRate + h.failRate >= minFlakeRate,
        )
        .sort(
            (a, b) => b.flakeRate + b.failRate - (a.flakeRate + a.failRate),
        );
}

export interface RunRollup {
    runId: string;
    ts: string;
    matrixId: string;
    verdict?: RunVerdict;
    total: number;
    applicable: number;
    executed: number;
    passed: number;
    failed: number;
    infraSkipped: number;
    setupSkipped: number;
    flaky: number;
}

/** One row per run, newest first. The "last N runs" strip. */
export function runRollups(rows: HistoryRow[]): RunRollup[] {
    const byRun = new Map<string, RunRollup>();
    for (const r of rows) {
        let u = byRun.get(r.runId);
        if (!u) {
            u = {
                runId: r.runId,
                ts: r.ts,
                matrixId: r.matrixId,
                verdict: r.verdict,
                total: 0,
                applicable: 0,
                executed: 0,
                passed: 0,
                failed: 0,
                infraSkipped: 0,
                setupSkipped: 0,
                flaky: 0,
            };
            byRun.set(r.runId, u);
        }
        u.total++;
        const notApplicable =
            r.status === "skipped" &&
            (r.skipKind ?? "not-applicable") === "not-applicable";
        if (!notApplicable) u.applicable++;
        if (r.status === "passed" || r.status === "failed") u.executed++;
        if (r.status === "passed") u.passed++;
        if (r.status === "failed") u.failed++;
        if (r.status === "skipped" && r.skipKind === "infra") u.infraSkipped++;
        if (r.status === "skipped" && r.skipKind === "setup") u.setupSkipped++;
        if (r.flaky) u.flaky++;
    }
    return [...byRun.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
