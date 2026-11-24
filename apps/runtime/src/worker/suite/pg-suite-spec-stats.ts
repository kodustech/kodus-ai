import type { Pool } from 'pg';

import type { SpecStats } from '@libs/runtime/suite';

/**
 * runtime.runtime_suite_spec_stats (docs/runtime/e2e-suites.md section 6): the duration each spec of an environment
 * takes, an exponential average over about the last 10 passing runs. Only a passing spec moves it: a failed, skipped
 * or timed-out spec is usually short (a crash) and would pull the median down. The next plan balances by it.
 */
export const STATS_WINDOW = 10;

export interface SpecObservation {
    spec: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
}

export class PgSuiteSpecStats {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** The stored median of each of `specs` that has one; the scope is the organization and the environment. */
    async read(scope: { organizationId: string; environmentId: string }, specs: readonly string[]): Promise<SpecStats> {
        if (specs.length === 0) return {};
        const r = await this.pool.query(
            `SELECT spec, p50_ms FROM runtime.runtime_suite_spec_stats WHERE organization_id = $1 AND environment_id = $2 AND spec = ANY($3::text[])`,
            [scope.organizationId, scope.environmentId, [...specs]],
        );
        return Object.fromEntries(r.rows.map((x) => [x.spec as string, { p50Ms: x.p50_ms as number }]));
    }

    /** Folds the passing specs of one run into their averages, atomically per spec (concurrent writers lose no sample). */
    async record(scope: { organizationId: string; environmentId: string }, sha: string, observed: readonly SpecObservation[]): Promise<void> {
        const passed = observed.filter((o) => o.status === 'passed' && Number.isFinite(o.durationMs) && o.durationMs >= 0);
        if (passed.length === 0) return;
        // One row per spec in a statement (a spec twice in one batch would hit the same row twice).
        const latest = new Map(passed.map((o) => [o.spec, Math.round(o.durationMs)]));
        const alpha = 2 / (STATS_WINDOW + 1);
        await this.pool.query(
            `INSERT INTO runtime.runtime_suite_spec_stats AS s (organization_id, environment_id, spec, p50_ms, last_ms, samples, last_seen_sha)
             SELECT $1, $2, r.spec, r.ms, r.ms, 1, $3 FROM jsonb_to_recordset($4::jsonb) AS r(spec text, ms int)
             ON CONFLICT (environment_id, spec) DO UPDATE SET
               p50_ms = round(s.p50_ms + $5::float8 * (EXCLUDED.last_ms - s.p50_ms))::int,
               last_ms = EXCLUDED.last_ms, samples = s.samples + 1, last_seen_sha = EXCLUDED.last_seen_sha, updated_at = now()
             WHERE s.organization_id = EXCLUDED.organization_id`,
            [scope.organizationId, scope.environmentId, sha, JSON.stringify([...latest].map(([spec, ms]) => ({ spec, ms }))), alpha],
        );
    }
}
