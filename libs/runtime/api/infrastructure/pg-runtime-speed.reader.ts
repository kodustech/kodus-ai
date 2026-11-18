import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { SpeedRunRow } from '../domain/runtime-speed';

/** The Speed card reads up to this many Runs of the window, the newest first; more says `truncated`. */
export const SPEED_ROW_LIMIT = 10_000;
const SPEED_QUERY_TIMEOUT_MS = 10_000;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface RuntimeSpeedReader {
    /** The org's Runs requested since `since`, the newest first, at most `limit`. */
    speedRuns(organizationId: string, since: Date, limit?: number): Promise<SpeedRunRow[]>;
}
export const RUNTIME_SPEED_READER = Symbol.for('RuntimeApi.SpeedReader');

/**
 * The Speed card's rows from the Runtime Postgres (RuntimeReadDb: the read-only
 * role, BEGIN READ ONLY). runtime_runs by (organization_id, requested_at); per
 * Run, the first probe step.started of each side from runtime_run_events (index
 * (org_id, run_id, seq)), and the start source and cell owner of each ready
 * claim (runtime_claims by run_id, runtime_cells by cell_id). No new table.
 */
export class PgRuntimeSpeedReader implements RuntimeSpeedReader {
    constructor(private readonly db: SqlQuery) {}

    async speedRuns(organizationId: string, since: Date, limit = SPEED_ROW_LIMIT): Promise<SpeedRunRow[]> {
        const r = await this.db.query(
            `SELECT r.run_id, r.environment_id, r.state, r.requested_at, r.started_at, r.finished_at,
                    p.base_probe_at, p.pr_probe_at, c.starts, c.owners
               FROM runtime.runtime_runs r
               LEFT JOIN LATERAL (
                    SELECT min(e.created_at) FILTER (WHERE e.event->'data'->>'side' = 'base') AS base_probe_at,
                           min(e.created_at) FILTER (WHERE e.event->'data'->>'side' = 'pr') AS pr_probe_at
                      FROM runtime.runtime_run_events e
                     WHERE e.org_id = $1 AND e.run_id = r.run_id
                       AND e.event->>'type' = 'step.started' AND e.event->'data' ? 'probeId'
               ) p ON true
               LEFT JOIN LATERAL (
                    SELECT array_agg(cl.start_source ORDER BY cl.side) AS starts, array_agg(ce.owner ORDER BY cl.side) AS owners
                      FROM runtime.runtime_claims cl
                      LEFT JOIN runtime.runtime_cells ce ON ce.cell_id = cl.cell_id
                     WHERE cl.run_id = r.run_id AND cl.org_id = $1 AND cl.ready_at IS NOT NULL
               ) c ON true
              WHERE r.organization_id = $1 AND r.requested_at >= $2
              ORDER BY r.requested_at DESC
              LIMIT $3`,
            [organizationId, since, limit],
            { timeoutMs: SPEED_QUERY_TIMEOUT_MS },
        );
        return r.rows.map((x: any) => ({
            runId: x.run_id,
            environmentId: x.environment_id ?? null,
            state: x.state,
            requestedAt: iso(x.requested_at),
            startedAt: iso(x.started_at),
            finishedAt: iso(x.finished_at),
            firstProbeAt: { base: iso(x.base_probe_at), pr: iso(x.pr_probe_at) },
            sideStarts: Array.isArray(x.starts) ? x.starts : [],
            sideOwners: Array.isArray(x.owners) ? x.owners : [],
        }));
    }
}
