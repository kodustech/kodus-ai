import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';
import type { CellSessionView, ClaimRowView, RunRow, SetupRow } from '@libs/runtime/health/stuck';

import type { HealthBlocker, HealthCell, HealthRun } from '../domain/runtime-health';

/** One owner screen, read often: each read is org-scoped, bounded and cut at 5 s. */
const HEALTH_QUERY_TIMEOUT_MS = 5_000;
const LIMIT = 500;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export interface RuntimeHealthReader {
    setups(organizationId: string): Promise<SetupRow[]>;
    runs(organizationId: string, since: Date): Promise<HealthRun[]>;
    liveRuns(organizationId: string): Promise<RunRow[]>;
    openClaims(organizationId: string): Promise<ClaimRowView[]>;
    blockers(organizationId: string, since: Date): Promise<HealthBlocker[]>;
    cells(organizationId: string): Promise<HealthCell[]>;
    sessions(organizationId: string): Promise<CellSessionView[]>;
}
export const RUNTIME_HEALTH_READER = Symbol.for('RuntimeApi.HealthReader');

/**
 * The Health screen's rows from the Runtime Postgres (RuntimeReadDb: the
 * read-only role, BEGIN READ ONLY): the tables the Run page, Environment
 * Health and the usage report already read, plus runtime_cell_sessions
 * (granted in scripts/runtime/runtime-reader-grants.sql). No new table.
 */
export class PgRuntimeHealthReader implements RuntimeHealthReader {
    constructor(private readonly db: SqlQuery) {}

    private q(text: string, values: unknown[]) {
        return this.db.query(text, values, { timeoutMs: HEALTH_QUERY_TIMEOUT_MS });
    }

    async setups(organizationId: string): Promise<SetupRow[]> {
        const r = await this.q(
            `SELECT environment_id, organization_id, setup_key, state, requested_at, updated_at FROM runtime.runtime_environment_setups
              WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT ${LIMIT}`,
            [organizationId],
        );
        return r.rows.map((x: any) => ({ environmentId: x.environment_id, organizationId: x.organization_id, setupKey: x.setup_key, state: x.state, requestedAt: iso(x.requested_at)!, updatedAt: iso(x.updated_at)! }));
    }

    async runs(organizationId: string, since: Date): Promise<HealthRun[]> {
        const r = await this.q(
            `SELECT run_id, state, verdict_state, requested_at, report->'bootMs' AS boot_ms FROM runtime.runtime_runs
              WHERE organization_id = $1 AND requested_at >= $2 ORDER BY requested_at DESC LIMIT 2000`,
            [organizationId, since],
        );
        return r.rows.map((x: any) => ({ runId: x.run_id, state: x.state, verdictState: x.verdict_state ?? null, requestedAt: iso(x.requested_at)!, bootMs: num(x.boot_ms) }));
    }

    async liveRuns(organizationId: string): Promise<RunRow[]> {
        const r = await this.q(
            `SELECT run_id, organization_id, environment_id, state, requested_at, report->>'bootingAt' AS booting_at, report->'capacityWait'->>'at' AS capacity_wait_at
               FROM runtime.runtime_runs WHERE organization_id = $1 AND state IN ('queued', 'awaiting_approval', 'booting', 'testing') LIMIT ${LIMIT}`,
            [organizationId],
        );
        return r.rows.map((x: any) => ({
            runId: x.run_id, organizationId: x.organization_id, environmentId: x.environment_id, state: x.state, requestedAt: iso(x.requested_at)!,
            bootingAt: x.booting_at ?? null, capacityWait: x.capacity_wait_at ? { at: x.capacity_wait_at } : null,
        }));
    }

    async openClaims(organizationId: string): Promise<ClaimRowView[]> {
        const r = await this.q(
            `SELECT claim_id, cell_id, org_id, run_id, environment_id, side, state, consumer, state_changed_at, created_at, hard_expires_at
               FROM runtime.runtime_claims WHERE org_id = $1 AND state IN ('pending','bound','held','blocked','failed','compromised') LIMIT ${LIMIT}`,
            [organizationId],
        );
        return r.rows.map((x: any) => ({
            claimId: x.claim_id, cellId: x.cell_id, orgId: x.org_id, runId: x.run_id, environmentId: x.environment_id, side: x.side, state: x.state,
            consumer: x.consumer, stateChangedAt: iso(x.state_changed_at), createdAt: iso(x.created_at), hardExpiresAt: iso(x.hard_expires_at)!,
        }));
    }

    /** The blockers of the setups and the Runs the screens show: a setup record's blockers, a Run's bootFailure. */
    async blockers(organizationId: string, since: Date): Promise<HealthBlocker[]> {
        const [setups, runs] = await Promise.all([
            this.q(
                `SELECT s.environment_id, b->>'kind' AS kind, b->>'signature' AS signature, b->>'message' AS message, b->>'at' AS at
                   FROM runtime.runtime_environment_setups s, jsonb_array_elements(COALESCE(s.record->'blockers', '[]'::jsonb)) b
                  WHERE s.organization_id = $1 AND s.updated_at >= $2 LIMIT 2000`,
                [organizationId, since],
            ),
            this.q(
                `SELECT run_id, environment_id, report->'bootFailure'->>'kind' AS kind, report->'bootFailure'->>'signature' AS signature,
                        report->'bootFailure'->>'title' AS message, report->'bootFailure'->>'at' AS at
                   FROM runtime.runtime_runs WHERE organization_id = $1 AND requested_at >= $2 AND report ? 'bootFailure' LIMIT 2000`,
                [organizationId, since],
            ),
        ]);
        const valid = (x: any) => typeof x.kind === 'string' && typeof x.signature === 'string' && typeof x.at === 'string';
        return [
            ...setups.rows.filter(valid).map((x: any) => ({ kind: x.kind, signature: x.signature, message: x.message ?? '', at: x.at, environmentId: x.environment_id, source: 'setup' as const })),
            ...runs.rows.filter(valid).map((x: any) => ({ kind: x.kind, signature: x.signature, message: x.message ?? '', at: x.at, environmentId: x.environment_id, runId: x.run_id, source: 'run' as const })),
        ];
    }

    async cells(organizationId: string): Promise<HealthCell[]> {
        const r = await this.q(
            `SELECT c.cell_id, c.owner, c.status, c.last_heartbeat_at, s.free_slots, s.isolation, s.driver, s.max_claim_memory_mb, s.max_claim_cpus, s.disconnected_at
               FROM runtime.runtime_cells c LEFT JOIN runtime.runtime_cell_sessions s ON s.cell_id = c.cell_id
              WHERE c.organization_id = $1 ORDER BY c.cell_id LIMIT ${LIMIT}`,
            [organizationId],
        );
        return r.rows.map((x: any) => ({
            cellId: x.cell_id, owner: x.owner, status: x.status, connected: !!x.driver && !x.disconnected_at, lastHeartbeatAt: iso(x.last_heartbeat_at),
            freeSlots: num(x.free_slots), isolation: x.isolation ?? null, driver: x.driver ?? null, maxClaimMemoryMb: num(x.max_claim_memory_mb), maxClaimCpus: num(x.max_claim_cpus),
        }));
    }

    async sessions(organizationId: string): Promise<CellSessionView[]> {
        const r = await this.q(`SELECT cell_id, org_id, last_heartbeat_at, disconnected_at FROM runtime.runtime_cell_sessions WHERE org_id = $1 AND disconnected_at IS NULL LIMIT ${LIMIT}`, [organizationId]);
        return r.rows.map((x: any) => ({ cellId: x.cell_id, orgId: x.org_id, lastHeartbeatAt: iso(x.last_heartbeat_at)!, disconnectedAt: null }));
    }
}
