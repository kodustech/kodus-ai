import type { Pool } from 'pg';

import { STABILITY_RETENTION_DAYS, StabilityRecord } from '@libs/runtime/gate';

import type { StabilityHistory, StabilityOutcome } from './ports';

/** The most recent Runs a policy is built from, per probe shape: older ones still count until retention removes them. */
export const STABILITY_READ_PER_KEY = 20;

/**
 * runtime.runtime_stability (§8, ADR-050): one row per Run and probe index,
 * scoped by org and environment, read by probe shape within 90 days. The
 * retention sweep (applyRetention) deletes what is older.
 */
export class PgStabilityHistory implements StabilityHistory {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async read(scope: { orgId: string; environmentId: string }, probeKeys: string[]): Promise<Record<string, StabilityRecord[]>> {
        const out: Record<string, StabilityRecord[]> = Object.fromEntries(probeKeys.map((k) => [k, []]));
        if (probeKeys.length === 0) return out;
        const { rows } = await this.pool.query<{ probe_key: string; normalizer_version: string; unstable_fields: string[]; verdict: StabilityRecord['verdict'] }>(
            `SELECT probe_key, normalizer_version, unstable_fields, verdict FROM (
                SELECT probe_key, normalizer_version, unstable_fields, verdict, recorded_at,
                       row_number() OVER (PARTITION BY probe_key ORDER BY recorded_at DESC, run_id, probe_index) AS n
                FROM runtime.runtime_stability
                WHERE org_id = $1 AND environment_id = $2 AND probe_key = ANY($3::text[])
                  AND recorded_at > now() - make_interval(days => $4)
            ) recent WHERE n <= $5 ORDER BY probe_key, recorded_at DESC`,
            [scope.orgId, scope.environmentId, probeKeys, STABILITY_RETENTION_DAYS, STABILITY_READ_PER_KEY],
        );
        for (const r of rows) out[r.probe_key]?.push({ normalizerVersion: r.normalizer_version, unstableFields: r.unstable_fields, verdict: r.verdict });
        return out;
    }

    async record(scope: { orgId: string; environmentId: string; runId: string }, outcomes: StabilityOutcome[]): Promise<void> {
        if (outcomes.length === 0) return;
        // One statement, idempotent per (org, Run, probe index): a retried step writes nothing twice.
        await this.pool.query(
            `INSERT INTO runtime.runtime_stability
                (org_id, environment_id, run_id, probe_index, probe_key, normalizer_version, unstable_fields, verdict, base_rounds, pr_rounds)
             SELECT $1, $2, $3, o.probe_index, o.probe_key, o.normalizer_version,
                    ARRAY(SELECT jsonb_array_elements_text(o.unstable_fields)), o.verdict, o.base_rounds, o.pr_rounds
             FROM jsonb_to_recordset($4::jsonb) AS o(probe_index int, probe_key text, normalizer_version text, unstable_fields jsonb, verdict text, base_rounds int, pr_rounds int)
             ON CONFLICT (org_id, run_id, probe_index) DO NOTHING`,
            [
                scope.orgId,
                scope.environmentId,
                scope.runId,
                JSON.stringify(
                    outcomes.map((o) => ({
                        probe_index: o.probeIndex,
                        probe_key: o.probeKey,
                        normalizer_version: o.normalizerVersion,
                        unstable_fields: o.unstableFields,
                        verdict: o.verdict,
                        base_rounds: o.baseRounds,
                        pr_rounds: o.prRounds,
                    })),
                ),
            ],
        );
    }
}
