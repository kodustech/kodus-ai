import type { Pool } from 'pg';

import type { SuiteMode } from '@libs/runtime/contracts/runtime-commands';
import type { Classification, SuiteSelectionReport } from '@libs/runtime/suite';

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
    /** How the specs were chosen (docs section 6.1): the whole suite with the reason, or the selection. Absent: the run never said. */
    selection?: SuiteSelectionReport;
}

export interface StoredSuiteRun extends SuiteRunRecord {
    state: SuiteRunState;
    suiteDigest?: string;
    finishedAt?: Date;
    /** Whose fault each red test was (docs section 9), written once with the conclusion; absent for a baseline and for a run that ended before it. */
    classification?: Classification;
    /** The baseline the run was judged against (its main sha) and how many main commits it was behind (8.2). */
    baselineSha?: string;
    baseDrift?: number;
    /** The machine time the run's hosts were held for, in ms summed over hosts: the first pass, and the re-runs (docs section 12). Absent on a run that did not measure it. */
    firstPassMs?: number;
    rerunMs?: number;
}

/** What a run ends with beside its state. */
export interface SuiteRunEnd {
    classification?: Classification;
    baselineSha?: string;
    baseDrift?: number;
    firstPassMs?: number;
    rerunMs?: number;
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

/** One artifact kept for a failed spec: the evidence key it was written under (`suite-artifact`) and what it is. */
export interface SuiteArtifactRef {
    name: string;
    key: string;
    contentType: string;
    bytes: number;
}

export interface StoredSuiteResult extends SuiteResultRow {
    phase: SuitePhase;
    shard: number;
    /** The artifacts kept for a failed spec (docs section 7); absent when none were. */
    artifacts?: SuiteArtifactRef[];
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
    ...(x.classification ? { classification: x.classification } : {}),
    ...(x.selection && Object.keys(x.selection).length ? { selection: x.selection } : {}),
    ...(x.baseline_sha ? { baselineSha: x.baseline_sha } : {}),
    ...(x.base_drift !== null && x.base_drift !== undefined ? { baseDrift: x.base_drift } : {}),
    ...(x.first_pass_ms !== null && x.first_pass_ms !== undefined ? { firstPassMs: Number(x.first_pass_ms) } : {}),
    ...(x.rerun_ms !== null && x.rerun_ms !== undefined ? { rerunMs: Number(x.rerun_ms) } : {}),
});

export class PgSuiteRuns {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async create(r: SuiteRunRecord): Promise<{ created: boolean }> {
        const out = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_runs (suite_run_id, organization_id, environment_id, repository_id, mode, pr_number, pr_sha, merge_base, main_sha, requested_at, selection)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) ON CONFLICT (suite_run_id) DO NOTHING`,
            [r.suiteRunId, r.organizationId, r.environmentId, r.repositoryId, r.mode, r.prNumber ?? null, r.prSha ?? null, r.mergeBase ?? null, r.mainSha, r.requestedAt, JSON.stringify(r.selection ?? {})],
        );
        return { created: (out.rowCount ?? 0) > 0 };
    }

    async get(organizationId: string, suiteRunId: string): Promise<StoredSuiteRun | null> {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_suite_runs WHERE organization_id = $1 AND suite_run_id = $2`, [organizationId, suiteRunId]);
        return r.rows[0] ? runOf(r.rows[0]) : null;
    }

    /** The newest run of a PR in the environment (a shadow is no run of the PR: it never feeds the re-push rule), from before `before` when given (a run never reads itself as its previous): what the re-push rule reads. */
    async latestForPr(organizationId: string, environmentId: string, prNumber: number, before?: Date): Promise<StoredSuiteRun | null> {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_suite_runs WHERE organization_id = $1 AND environment_id = $2 AND pr_number = $3 AND mode <> 'shadow' AND ($4::timestamptz IS NULL OR requested_at < $4) ORDER BY requested_at DESC LIMIT 1`,
            [organizationId, environmentId, prNumber, before ?? null],
        );
        return r.rows[0] ? runOf(r.rows[0]) : null;
    }

    /** The PR's suite runs that have not ended (a baseline is no PR's, and a shadow is background work that a new push does not cancel), except those of `keepHead`: what a newer push or a closed PR cancels. */
    async livePullRequestRuns(organizationId: string, repositoryId: string, prNumber: number, keepHead?: string): Promise<Array<{ suiteRunId: string; mode: SuiteMode }>> {
        const r = await this.pool.query(
            `SELECT suite_run_id, mode FROM runtime.runtime_suite_runs
             WHERE organization_id = $1 AND repository_id = $2 AND pr_number = $3 AND finished_at IS NULL AND mode NOT IN ('baseline', 'shadow') AND ($4::text IS NULL OR pr_sha IS DISTINCT FROM $4)
             ORDER BY requested_at`,
            [organizationId, repositoryId, prNumber, keepHead ?? null],
        );
        return r.rows.map((x) => ({ suiteRunId: x.suite_run_id, mode: x.mode }));
    }

    /** The first conclusion stays: a run that ended is never moved again. */
    async finish(organizationId: string, suiteRunId: string, state: SuiteRunState, at: Date, end: SuiteRunEnd = {}): Promise<void> {
        await this.pool.query(
            `UPDATE runtime.runtime_suite_runs SET state = $3, finished_at = $4, classification = $5::jsonb, baseline_sha = $6, base_drift = $7, first_pass_ms = $8, rerun_ms = $9, updated_at = now() WHERE organization_id = $1 AND suite_run_id = $2 AND finished_at IS NULL`,
            [organizationId, suiteRunId, state, at, end.classification ? JSON.stringify(end.classification) : null, end.baselineSha ?? null, end.baseDrift ?? null, end.firstPassMs ?? null, end.rerunMs ?? null],
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

    /** A shard's claim turned ready (`running`, started_at) or its specs ended (`finished`, finished_at). */
    async markShard(organizationId: string, suiteRunId: string, shard: number, moment: 'running' | 'finished', at: Date): Promise<void> {
        await this.pool.query(
            moment === 'running'
                ? `UPDATE runtime.runtime_suite_shards SET state = 'running', started_at = $4, updated_at = now() WHERE organization_id = $1 AND suite_run_id = $2 AND shard = $3`
                : `UPDATE runtime.runtime_suite_shards SET state = 'finished', finished_at = $4, updated_at = now() WHERE organization_id = $1 AND suite_run_id = $2 AND shard = $3`,
            [organizationId, suiteRunId, shard, at],
        );
    }

    /** The run is over: a shard that never reported its end (a host lost, a process that died) is closed, so nothing shows it running. */
    async closeShards(organizationId: string, suiteRunId: string, at: Date): Promise<void> {
        await this.pool.query(
            `UPDATE runtime.runtime_suite_shards SET state = 'finished', finished_at = COALESCE(finished_at, $3), updated_at = now() WHERE organization_id = $1 AND suite_run_id = $2 AND state <> 'finished'`,
            [organizationId, suiteRunId, at],
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

    /** Adds the kept artifacts to the results already recorded for these specs (a spec with no row is left alone). */
    async recordArtifacts(organizationId: string, suiteRunId: string, from: { phase: SuitePhase; shard: number }, rows: ReadonlyArray<{ spec: string; artifacts: readonly SuiteArtifactRef[] }>): Promise<void> {
        if (rows.length === 0) return;
        await this.pool.query(
            `UPDATE runtime.runtime_suite_results t SET artifacts = r.artifacts
               FROM jsonb_to_recordset($4::jsonb) AS r(spec text, artifacts jsonb)
              WHERE t.suite_run_id = $1 AND t.organization_id = $2 AND t.phase = $3 AND t.spec = r.spec`,
            [suiteRunId, organizationId, from.phase, JSON.stringify(rows.map((x) => ({ spec: x.spec, artifacts: x.artifacts })))],
        );
    }

    async results(organizationId: string, suiteRunId: string): Promise<StoredSuiteResult[]> {
        const r = await this.pool.query(
            `SELECT phase, shard, spec, status, duration_ms, error_signature, tests, artifacts FROM runtime.runtime_suite_results WHERE organization_id = $1 AND suite_run_id = $2 ORDER BY phase, spec`,
            [organizationId, suiteRunId],
        );
        return r.rows.map((x) => ({ phase: x.phase, shard: x.shard, spec: x.spec, status: x.status, durationMs: x.duration_ms, ...(x.error_signature ? { errorSignature: x.error_signature } : {}), tests: x.tests, ...(x.artifacts ? { artifacts: x.artifacts } : {}) }));
    }
}
