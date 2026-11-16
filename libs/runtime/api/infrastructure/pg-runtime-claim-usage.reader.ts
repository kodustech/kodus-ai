import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { RuntimeClaimUsageReader } from '../domain/ports';
import type { RunClaimUsage } from '../domain/run-cost';

interface ClaimUsageRow {
    claim_id: string;
    cell_id: string;
    run_id: string;
    side: string;
    state: string;
    driver: string | null;
    memory_mb_boot: number | null;
    memory_mb_ready: number | null;
    memory_allocatable_mb: number | null;
    cpus: number | null;
    admitted_at: Date | null;
    ready_at: Date | null;
    released_at: Date | null;
    state_changed_at: Date | null;
    hard_expires_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * The claim rounds of Runs (runtime.runtime_claims, migration 11) from the
 * Runtime Postgres, through the shared read-only RuntimeReadDb (ADR-025): one
 * query for the whole page, org-scoped, on runtime_claims_run_idx. Without
 * RUNTIME_DATABASE_READ_URL it fails with 503, as every Runtime read does (the
 * Run cost then leaves the machine time unpriced).
 */
export class PgRuntimeClaimUsageReader implements RuntimeClaimUsageReader {
    constructor(private readonly db: SqlQuery) {}

    async claimsOfRuns(organizationId: string, runIds: string[]): Promise<Map<string, RunClaimUsage[]>> {
        const out = new Map<string, RunClaimUsage[]>();
        if (!runIds.length) return out;
        const rows = (
            await this.db.query(
                `SELECT claim_id, cell_id, run_id, side, state, driver, memory_mb_boot, memory_mb_ready, memory_allocatable_mb, cpus,
                        admitted_at, ready_at, released_at, state_changed_at, hard_expires_at
                   FROM runtime.runtime_claims
                  WHERE run_id = ANY($2) AND org_id = $1
                  ORDER BY created_at
                  LIMIT 1000`,
                [organizationId, runIds],
            )
        ).rows as ClaimUsageRow[];
        for (const r of rows) {
            const list = out.get(r.run_id) ?? [];
            list.push({
                claimId: r.claim_id,
                cellId: r.cell_id,
                side: r.side,
                state: r.state,
                driver: r.driver,
                bootMb: r.memory_mb_boot,
                readyMb: r.memory_mb_ready,
                allocatableMb: r.memory_allocatable_mb,
                cpus: r.cpus,
                admittedAt: iso(r.admitted_at),
                readyAt: iso(r.ready_at),
                releasedAt: iso(r.released_at),
                stateChangedAt: iso(r.state_changed_at),
                hardExpiresAt: iso(r.hard_expires_at),
            });
            out.set(r.run_id, list);
        }
        return out;
    }
}
