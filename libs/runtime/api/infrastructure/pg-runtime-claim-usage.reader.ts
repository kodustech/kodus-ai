import { Pool } from 'pg';

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
    admitted_at: Date | null;
    ready_at: Date | null;
    released_at: Date | null;
    state_changed_at: Date | null;
    hard_expires_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * The claim rounds of Runs (runtime.runtime_claims, migration 11) from the
 * Runtime Postgres, with the read-only URL (RUNTIME_DATABASE_READ_URL, role
 * kodus_runtime_reader) inside BEGIN READ ONLY (ADR-025): one query for the
 * whole page, org-scoped, on runtime_claims_run_idx. Without the URL every
 * Run reads as having no recorded claim (its machine time is not priced).
 */
export class PgRuntimeClaimUsageReader implements RuntimeClaimUsageReader {
    private pool?: Pool;

    constructor(private readonly url: string | undefined) {}

    async claimsOfRuns(organizationId: string, runIds: string[]): Promise<Map<string, RunClaimUsage[]>> {
        const out = new Map<string, RunClaimUsage[]>();
        if (!this.url || !runIds.length) return out;
        this.pool ??= new Pool({ connectionString: this.url, max: 2, idleTimeoutMillis: 30_000 });
        const client = await this.pool.connect();
        let rows: ClaimUsageRow[];
        try {
            await client.query('BEGIN READ ONLY');
            rows = (
                await client.query<ClaimUsageRow>(
                    `SELECT claim_id, cell_id, run_id, side, state, driver, memory_mb_boot, memory_mb_ready, memory_allocatable_mb,
                            admitted_at, ready_at, released_at, state_changed_at, hard_expires_at
                       FROM runtime.runtime_claims
                      WHERE run_id = ANY($2) AND org_id = $1
                      ORDER BY created_at
                      LIMIT 1000`,
                    [organizationId, runIds],
                )
            ).rows;
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
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

    async onModuleDestroy() {
        await this.pool?.end();
    }
}
