import type { Pool } from 'pg';

import type { SuiteMode } from '@libs/runtime/contracts/runtime-commands';

/**
 * The suite run, its shards and its per-spec results (docs/runtime/e2e-suites.md section 7): runtime_suite_runs,
 * runtime_suite_shards, runtime_suite_results. Every read names the organization. A request delivered twice finds
 * its run; a shard reporting a spec twice writes it once (the row is the spec and the phase).
 */
export const SUITE_RUN_STATES = ['requested', 'running', 'passed', 'failed', 'neutral', 'timed_out', 'cancelled', 'errored'] as const;
export type SuiteRunState = (typeof SUITE_RUN_STATES)[number];

/** Where a result came from: the first pass of a shard, or a re-run of a failed spec on the PR or on main. */
export const SUITE_PHASES = ['shard', 'rerun_pr', 'rerun_main'] as const;
export type SuitePhase = (typeof SUITE_PHASES)[number];

export interface SuiteRunRecord {
    suiteRunId: string;
    organizationId: string;
    environmentId: string;
    repositoryId: string;
    mode: SuiteMode;
    prNumber?: number;
    prSha?: string;
    mergeBase?: string;
    mainSha: string;
    requestedAt: Date;
}

export interface StoredSuiteRun extends SuiteRunRecord {
    state: SuiteRunState;
    suiteDigest?: string;
    finishedAt?: Date;
}

export interface SuiteShardPlan {
    shard: number;
    specs: string[];
}

export interface StoredSuiteShard extends SuiteShardPlan {
    state: string;
}

/** What a spec ended as: a runner's verdict, or `not_run` (the shard stopped first) and `infra` (the host or the runner, never the PR). */
export type SuiteSpecStatus = 'passed' | 'failed' | 'skipped' | 'not_run' | 'infra';

export interface SuiteResultRow {
    spec: string;
    status: SuiteSpecStatus;
    durationMs: number;
    errorSignature?: string;
    tests: unknown[];
}

export interface StoredSuiteResult extends SuiteResultRow {
    phase: SuitePhase;
    shard: number;
}

const runOf = (x: Record<string, any>): StoredSuiteRun => ({
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
    ...(x.suite_digest ? { suiteDigest: x.suite_digest } : {}),
    requestedAt: x.requested_at,
    ...(x.finished_at ? { finishedAt: x.finished_at } : {}),
});

export class PgSuiteRuns {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async create(r: SuiteRunRecord): Promise<{ created: boolean }> {
        const out = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_runs (suite_run_id, organization_id, environment_id, repository_id, mode, pr_number, pr_sha, merge_base, main_sha, requested_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (suite_run_id) DO NOTHING`,
            [r.suiteRunId, r.organizationId, r.environmentId, r.repositoryId, r.mode, r.prNumber ?? null, r.prSha ?? null, r.mergeBase ?? null, r.mainSha, r.requestedAt],
        );
        return { created: (out.rowCount ?? 0) > 0 };
    }

    async get(organizationId: string, suiteRunId: string): Promise<StoredSuiteRun | null> {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_suite_runs WHERE organization_id = $1 AND suite_run_id = $2`, [organizationId, suiteRunId]);
        return r.rows[0] ? runOf(r.rows[0]) : null;
    }

    /** The newest earlier run of a PR in the environment: what the re-push rule reads. */
    async latestForPr(organizationId: string, environmentId: string, prNumber: number): Promise<StoredSuiteRun | null> {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_suite_runs WHERE organization_id = $1 AND environment_id = $2 AND pr_number = $3 ORDER BY requested_at DESC LIMIT 1`,
            [organizationId, environmentId, prNumber],
        );
        return r.rows[0] ? runOf(r.rows[0]) : null;
    }

    /** The first conclusion stays: a run that ended is never moved again. */
    async finish(organizationId: string, suiteRunId: string, state: SuiteRunState, at: Date): Promise<void> {
        await this.pool.query(
            `UPDATE runtime.runtime_suite_runs SET state = $3, finished_at = $4, updated_at = now() WHERE organization_id = $1 AND suite_run_id = $2 AND finished_at IS NULL`,
            [organizationId, suiteRunId, state, at],
        );
    }

    /** The specs each shard runs; a shard planned again keeps its row and takes the new list. */
    async savePlan(organizationId: string, suiteRunId: string, shards: readonly SuiteShardPlan[]): Promise<void> {
        if (shards.length === 0) return;
        await this.pool.query(
            `INSERT INTO runtime.runtime_suite_shards (suite_run_id, shard, organization_id, specs)
             SELECT $1, s.shard, $2, s.specs FROM jsonb_to_recordset($3::jsonb) AS s(shard int, specs jsonb)
             ON CONFLICT (suite_run_id, shard) DO UPDATE SET specs = EXCLUDED.specs, updated_at = now() WHERE runtime_suite_shards.organization_id = EXCLUDED.organization_id`,
            [suiteRunId, organizationId, JSON.stringify(shards)],
        );
    }

    async shards(organizationId: string, suiteRunId: string): Promise<StoredSuiteShard[]> {
        const r = await this.pool.query(`SELECT shard, state, specs FROM runtime.runtime_suite_shards WHERE organization_id = $1 AND suite_run_id = $2 ORDER BY shard`, [organizationId, suiteRunId]);
        return r.rows.map((x) => ({ shard: x.shard, state: x.state, specs: x.specs }));
    }

    /** One row per spec and phase: a result reported again replaces the earlier one. */
    async recordResults(organizationId: string, suiteRunId: string, from: { phase: SuitePhase; shard: number }, results: readonly SuiteResultRow[]): Promise<void> {
        if (results.length === 0) return;
        const rows = results.map((r) => ({ spec: r.spec, status: r.status, ms: Math.round(r.durationMs), sig: r.errorSignature ?? null, tests: r.tests }));
        await this.pool.query(
            `INSERT INTO runtime.runtime_suite_results (suite_run_id, phase, spec, organization_id, shard, status, duration_ms, error_signature, tests)
             SELECT $1, $2, r.spec, $3, $4, r.status, r.ms, r.sig, r.tests FROM jsonb_to_recordset($5::jsonb) AS r(spec text, status text, ms int, sig text, tests jsonb)
             ON CONFLICT (suite_run_id, phase, spec) DO UPDATE SET shard = EXCLUDED.shard, status = EXCLUDED.status, duration_ms = EXCLUDED.duration_ms,
               error_signature = EXCLUDED.error_signature, tests = EXCLUDED.tests, recorded_at = now() WHERE runtime_suite_results.organization_id = EXCLUDED.organization_id`,
            [suiteRunId, from.phase, organizationId, from.shard, JSON.stringify(rows)],
        );
    }

    async results(organizationId: string, suiteRunId: string): Promise<StoredSuiteResult[]> {
        const r = await this.pool.query(
            `SELECT phase, shard, spec, status, duration_ms, error_signature, tests FROM runtime.runtime_suite_results WHERE organization_id = $1 AND suite_run_id = $2 ORDER BY phase, spec`,
            [organizationId, suiteRunId],
        );
        return r.rows.map((x) => ({ phase: x.phase, shard: x.shard, spec: x.spec, status: x.status, durationMs: x.duration_ms, ...(x.error_signature ? { errorSignature: x.error_signature } : {}), tests: x.tests }));
    }
}
