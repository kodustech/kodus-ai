import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type {
    RuntimeSuiteReader,
    StoredBaselineRequest,
    StoredBaselineSummary,
    StoredSelectionMiss,
    StoredSelectionState,
    StoredSuiteHost,
    StoredSuiteResultRecord,
    StoredSuiteRun,
    StoredSuiteRunRecord,
    StoredSuiteSavings,
    StoredSuiteUsageRow,
} from '../domain/suite';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);
/** A value inside a LIKE pattern, matched as itself. */
const likeLiteral = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
/** A host row of the run: its shard is the bound key's last segment; a key that does not end in one is not a shard's host. */
function suiteHostOf(h: { bound_key: string; created_at: Date; ready_at: Date | null; terminated_at: Date | null }): StoredSuiteHost[] {
    const shard = Number(h.bound_key.slice(h.bound_key.lastIndexOf('/') + 1));
    if (!Number.isInteger(shard) || shard < 0) return [];
    return [{ shard, requestedAt: iso(h.created_at)!, ...(h.ready_at ? { readyAt: iso(h.ready_at)! } : {}), ...(h.terminated_at ? { endedAt: iso(h.terminated_at)! } : {}) }];
}
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
/** A usage month is read on the reports' pool: a slow month still answers, a runaway one is cancelled by the server. */
const REPORT_QUERY_TIMEOUT_MS = 15_000;

/**
 * The e2e suite's tables as the product reads them (docs/runtime/e2e-suites.md sections 7 and 13): runtime_suite_runs, _shards,
 * _results, _baselines, _shadows and _selection_state, through RuntimeReadDb (the read-only role, every query inside BEGIN READ ONLY).
 * Every read names the organization; the tables are granted whole in scripts/runtime/runtime-reader-grants.sql. The Runtime writes them.
 */
export class PgSuiteReader implements RuntimeSuiteReader {
    /** `db` answers the screens; `reports` the month's usage (up to 15 s, the reports' pool). */
    constructor(
        private readonly db: SqlQuery,
        private readonly reports: SqlQuery = db,
    ) {}

    async get(organizationId: string, suiteRunId: string): Promise<StoredSuiteRun | null> {
        const runs = await this.db.query(
            `SELECT suite_run_id, organization_id, environment_id, repository_id, mode, state, pr_number, pr_sha, merge_base, main_sha, selection,
                    classification, baseline_sha, base_drift, first_pass_ms, rerun_ms, requested_at, finished_at
               FROM runtime.runtime_suite_runs WHERE organization_id = $1 AND suite_run_id = $2`,
            [organizationId, suiteRunId],
        );
        const x = runs.rows[0];
        if (!x) return null;
        const [shards, results, hosts] = await Promise.all([
            this.db.query(`SELECT shard, specs, started_at, finished_at FROM runtime.runtime_suite_shards WHERE organization_id = $1 AND suite_run_id = $2 ORDER BY shard`, [organizationId, suiteRunId]),
            this.db.query(
                `SELECT phase, shard, spec, status, duration_ms, error_signature, tests, artifacts
                   FROM runtime.runtime_suite_results WHERE organization_id = $1 AND suite_run_id = $2 ORDER BY phase, spec`,
                [organizationId, suiteRunId],
            ),
            // The fleet's hosts of this run, by their bound key; only the times. A deployment whose reader cannot see them shows no host times.
            this.db
                .query(
                    `SELECT bound_key, created_at, ready_at, terminated_at FROM runtime.runtime_hosts
                      WHERE organization_id = $1 AND bound_key LIKE $2 ESCAPE '\\' ORDER BY created_at`,
                    [organizationId, `suite:${likeLiteral(organizationId)}/${likeLiteral(suiteRunId)}/%`],
                )
                .then((r) => r.rows, () => null),
        ]);
        const run: StoredSuiteRunRecord = {
            suiteRunId: x.suite_run_id,
            organizationId: x.organization_id,
            environmentId: x.environment_id,
            repositoryId: x.repository_id,
            mode: x.mode,
            state: x.state,
            ...(x.pr_number !== null ? { prNumber: x.pr_number } : {}),
            ...(x.pr_sha ? { prSha: x.pr_sha } : {}),
            ...(x.merge_base ? { mergeBase: x.merge_base } : {}),
            mainSha: x.main_sha,
            ...(x.selection && Object.keys(x.selection).length ? { selection: x.selection } : {}),
            ...(x.classification ? { classification: x.classification } : {}),
            ...(x.baseline_sha ? { baselineSha: x.baseline_sha } : {}),
            ...(num(x.base_drift) !== undefined ? { baseDrift: num(x.base_drift)! } : {}),
            ...(num(x.first_pass_ms) !== undefined ? { firstPassMs: num(x.first_pass_ms)! } : {}),
            ...(num(x.rerun_ms) !== undefined ? { rerunMs: num(x.rerun_ms)! } : {}),
            requestedAt: iso(x.requested_at)!,
            ...(x.finished_at ? { finishedAt: iso(x.finished_at)! } : {}),
        };
        return {
            run,
            shards: shards.rows.map((s) => ({ shard: s.shard, specs: s.specs, ...(s.started_at ? { startedAt: iso(s.started_at)! } : {}), ...(s.finished_at ? { finishedAt: iso(s.finished_at)! } : {}) })),
            ...(hosts ? { hosts: hosts.flatMap((h) => suiteHostOf(h)) } : {}),
            results: results.rows.map(
                (r): StoredSuiteResultRecord => ({
                    phase: r.phase,
                    shard: r.shard,
                    spec: r.spec,
                    status: r.status,
                    durationMs: r.duration_ms,
                    ...(r.error_signature ? { errorSignature: r.error_signature } : {}),
                    tests: r.tests ?? [],
                    artifacts: r.artifacts ?? [],
                }),
            ),
        };
    }

    async liveRunAfter(organizationId: string, environmentId: string, prNumber: number, after: string, withinMs: number): Promise<boolean> {
        const r = await this.db.query(
            `SELECT 1 FROM runtime.runtime_suite_runs
              WHERE organization_id = $1 AND environment_id = $2 AND pr_number = $3 AND mode <> 'shadow'
                AND requested_at > $4 AND requested_at > now() - make_interval(secs => $5::double precision / 1000) AND finished_at IS NULL
              LIMIT 1`,
            [organizationId, environmentId, prNumber, after, withinMs],
        );
        return r.rows.length > 0;
    }

    async selectionState(organizationId: string, environmentId: string): Promise<StoredSelectionState> {
        const r = await this.db.query(`SELECT off, off_by, full_prs_left, reenabled_at FROM runtime.runtime_suite_selection_state WHERE organization_id = $1 AND environment_id = $2`, [organizationId, environmentId]);
        const x = r.rows[0];
        if (!x) return { off: false, fullPrsLeft: 0 };
        return { off: x.off === true, ...(x.off && x.off_by ? { offBy: x.off_by } : {}), fullPrsLeft: x.full_prs_left, ...(x.reenabled_at ? { reenabledAt: iso(x.reenabled_at)! } : {}) };
    }

    async lastBaseline(organizationId: string, environmentId: string): Promise<StoredBaselineSummary | null> {
        const r = await this.db.query(
            `SELECT main_sha, finished_at,
                    (SELECT count(*)::int FROM jsonb_each(specs)) AS total,
                    (SELECT count(*)::int FROM jsonb_each(specs) e WHERE e.value->>'status' = 'passed') AS passed,
                    (SELECT count(*)::int FROM jsonb_each(specs) e WHERE e.value->>'status' = 'failed') AS failed
               FROM runtime.runtime_suite_baselines
              WHERE organization_id = $1 AND environment_id = $2 AND status = 'complete'
              ORDER BY finished_at DESC LIMIT 1`,
            [organizationId, environmentId],
        );
        const x = r.rows[0];
        return x ? { sha: x.main_sha, specs: x.total, passed: x.passed, failed: x.failed, finishedAt: iso(x.finished_at)! } : null;
    }

    async lastBaselineRequest(organizationId: string, environmentId: string): Promise<StoredBaselineRequest | null> {
        const r = await this.db.query(
            `SELECT main_sha, state, reason FROM runtime.runtime_suite_baseline_requests
              WHERE organization_id = $1 AND environment_id = $2 ORDER BY requested_at DESC, main_sha LIMIT 1`,
            [organizationId, environmentId],
        );
        const x = r.rows[0];
        return x ? { sha: x.main_sha, state: x.state, ...(x.reason ? { reason: x.reason } : {}) } : null;
    }

    async lastMiss(organizationId: string, environmentId: string, since?: string): Promise<StoredSelectionMiss | null> {
        const r = await this.db.query(
            `SELECT pr_number, selection_misses FROM runtime.runtime_suite_shadows
              WHERE organization_id = $1 AND environment_id = $2 AND state = 'done' AND jsonb_array_length(selection_misses) > 0 AND ($3::timestamptz IS NULL OR finished_at > $3)
              ORDER BY finished_at DESC LIMIT 1`,
            [organizationId, environmentId, since ?? null],
        );
        const x = r.rows[0];
        return x ? { prNumber: x.pr_number, specs: x.selection_misses } : null;
    }

    async usageOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<{ rows: StoredSuiteUsageRow[]; savings: StoredSuiteSavings | null }> {
        const [by, saved] = await Promise.all([
            this.reports.query(
                `SELECT mode, count(*)::int AS runs, coalesce(sum(first_pass_ms), 0)::float8 AS first_pass_ms, coalesce(sum(rerun_ms), 0)::float8 AS rerun_ms,
                        count(*) FILTER (WHERE rerun_ms > 0)::int AS with_rerun, count(*) FILTER (WHERE first_pass_ms IS NULL)::int AS unmeasured
                   FROM runtime.runtime_suite_runs
                  WHERE organization_id = $1 AND requested_at >= $2 AND requested_at < $3
                  GROUP BY mode`,
                [organizationId, window.start, window.end],
                { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
            ),
            // A shadow is the selected run run again in full: its first-pass time less the selected run's is what selection saved, measured.
            this.reports.query(
                `SELECT count(*)::int AS pairs, coalesce(sum(f.first_pass_ms - s.first_pass_ms), 0)::float8 AS saved_ms
                   FROM runtime.runtime_suite_shadows h
                   JOIN runtime.runtime_suite_runs f ON f.suite_run_id = h.shadow_run_id AND f.organization_id = h.organization_id
                   JOIN runtime.runtime_suite_runs s ON s.suite_run_id = h.source_run_id AND s.organization_id = h.organization_id
                  WHERE h.organization_id = $1 AND h.state = 'done' AND h.conclusive AND h.finished_at >= $2 AND h.finished_at < $3
                    AND f.first_pass_ms IS NOT NULL AND s.first_pass_ms IS NOT NULL`,
                [organizationId, window.start, window.end],
                { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
            ),
        ]);
        return {
            rows: by.rows.map((r) => ({ mode: r.mode, runs: r.runs, firstPassMs: Number(r.first_pass_ms), rerunMs: Number(r.rerun_ms), withRerun: r.with_rerun, unmeasured: r.unmeasured })),
            savings: { shadowedRuns: saved.rows[0]?.pairs ?? 0, savedMs: Number(saved.rows[0]?.saved_ms ?? 0) },
        };
    }
}
