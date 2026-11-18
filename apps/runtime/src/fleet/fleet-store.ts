import { createHash } from 'crypto';

import type { Pool } from 'pg';

import { HostPoolSchema, type HostPool } from '@libs/runtime/fleet/pool';
import { LIVE_CLAIM_STATES } from '@libs/runtime/contracts/enums';

// What runtime-fleet reads and writes in the Runtime database
// (docs/runtime/host-providers.md §5.2): pools (status only; the spec is
// applied), hosts and their events, and the answer to the worker's demand.
// It reads cells, sessions and claims; it never writes them (the hub does).

export const HOST_STATES = ['requested', 'provisioning', 'bootstrapping', 'ready', 'draining', 'terminating', 'terminated', 'failed'] as const;
export type HostState = (typeof HOST_STATES)[number];

/** Why a host moved: a closed set, as claims have ClaimReason. */
export const HOST_REASONS = ['demand', 'created', 'running', 'registered', 'served', 'expired', 'failed', 'destroyed', 'orphan'] as const;
export type HostReason = (typeof HOST_REASONS)[number];

/** Why a host could not serve its Run: what the Run's blocker names (host_unavailable). */
export const HOST_FAILURES = ['pool_gone', 'template_missing', 'token_refused', 'provider_refused', 'provider_unavailable', 'registration_timeout', 'host_lost'] as const;
export type HostFailure = (typeof HOST_FAILURES)[number];

export interface StoredPool {
    poolId: string;
    pool: HostPool;
    status: PoolStatus;
}

export interface PoolStatus {
    scalable?: boolean;
    consecutiveFailures?: number;
    lastFailureAt?: string;
    lastError?: string;
    reason?: string;
}

export interface Demand {
    poolId: string;
    boundKey: string;
    organizationId: string;
    environmentId: string | null;
    runId: string | null;
    hostId: string | null;
}

export interface HostRow {
    hostId: string;
    poolId: string;
    provider: string;
    providerId: string | null;
    state: HostState;
    boundKey: string | null;
    organizationId: string | null;
}

export interface FleetStore {
    /** Pools a controller drives (provider not static) whose spec parses; a spec that does not is skipped and named. */
    controlledPools(): Promise<{ pools: StoredPool[]; invalid: string[] }>;
    pool(poolId: string): Promise<StoredPool | null>;
    setPoolStatus(poolId: string, status: PoolStatus): Promise<void>;
    /** One host failed (or served): the breaker's count, reset by a host that registered. */
    recordPoolOutcome(poolId: string, outcome: { ok: true } | { ok: false; reason: string }): Promise<void>;
    /** Demand that is live (not expired) and not failed. */
    openDemand(poolId: string): Promise<Demand[]>;
    /** Binds a demand to its host once; false when another replica already did. */
    claimDemand(poolId: string, boundKey: string, hostId: string): Promise<boolean>;
    /** Whether the Run still asks for its host (its demand not expired). */
    demandLive(poolId: string, boundKey: string): Promise<boolean>;
    failDemand(poolId: string, boundKey: string, failure: HostFailure): Promise<void>;
    /** Inserts the host row before any provider call; a second insert of the same host is a no-op. */
    insertHost(h: Omit<HostRow, 'state' | 'providerId'> & { usdPerHour?: number }): Promise<void>;
    host(hostId: string): Promise<HostRow | null>;
    /** Moves a host and records the event; never moves a terminated one. */
    moveHost(hostId: string, to: HostState, reason: HostReason, patch?: { providerId?: string; lastError?: string }): Promise<void>;
    liveHosts(poolId?: string): Promise<HostRow[]>;
    /** The cell a fleet host registered and whether it is connected now. */
    hostCell(hostId: string): Promise<{ cellId: string; connected: boolean } | null>;
    /** Live claims on the host's cell. */
    liveClaimsOnHost(hostId: string): Promise<number>;
}

/** The host a Run's demand on a pool gets: derived, so every replica and every retry names the same host. */
export const fleetHostId = (poolId: string, boundKey: string) => `host-${createHash('sha256').update(`${poolId}\n${boundKey}`).digest('hex').slice(0, 24)}`;

export class PgFleetStore implements FleetStore {
    constructor(private readonly db: Pick<Pool, 'query'>) {}

    async controlledPools() {
        const rows = (await this.db.query(`SELECT pool_id, spec, status FROM runtime.runtime_host_pools WHERE provider <> 'static' ORDER BY pool_id`)).rows;
        const pools: StoredPool[] = [];
        const invalid: string[] = [];
        for (const r of rows) {
            const parsed = HostPoolSchema.safeParse(r.spec);
            if (parsed.success) pools.push({ poolId: r.pool_id, pool: parsed.data, status: r.status ?? {} });
            else invalid.push(r.pool_id);
        }
        return { pools, invalid };
    }

    async pool(poolId: string) {
        const r = (await this.db.query(`SELECT pool_id, spec, status FROM runtime.runtime_host_pools WHERE pool_id = $1`, [poolId])).rows[0];
        const parsed = r ? HostPoolSchema.safeParse(r.spec) : undefined;
        return r && parsed?.success ? { poolId: r.pool_id, pool: parsed.data, status: r.status ?? {} } : null;
    }

    async setPoolStatus(poolId: string, status: PoolStatus) {
        await this.db.query(`UPDATE runtime.runtime_host_pools SET status = status || $2::jsonb, updated_at = now() WHERE pool_id = $1`, [poolId, JSON.stringify(status)]);
    }

    async recordPoolOutcome(poolId: string, outcome: { ok: true } | { ok: false; reason: string }) {
        if (outcome.ok === true) {
            await this.db.query(`UPDATE runtime.runtime_host_pools SET status = status || '{"consecutiveFailures": 0}'::jsonb, updated_at = now() WHERE pool_id = $1`, [poolId]);
            return;
        }
        const reason = outcome.ok === false ? outcome.reason : 'failed';
        await this.db.query(
            `UPDATE runtime.runtime_host_pools SET status = status || jsonb_build_object('consecutiveFailures', COALESCE((status->>'consecutiveFailures')::int, 0) + 1,
               'lastFailureAt', to_jsonb(now()), 'lastError', $2::text), updated_at = now() WHERE pool_id = $1`,
            [poolId, reason],
        );
    }

    async openDemand(poolId: string) {
        const r = await this.db.query(
            `SELECT pool_id, bound_key, organization_id, environment_id, run_id, host_id FROM runtime.runtime_pool_demand
              WHERE pool_id = $1 AND failed_at IS NULL AND expires_at > now() ORDER BY since LIMIT 500`,
            [poolId],
        );
        return r.rows.map((x) => ({ poolId: x.pool_id, boundKey: x.bound_key, organizationId: x.organization_id, environmentId: x.environment_id, runId: x.run_id, hostId: x.host_id }));
    }

    async claimDemand(poolId: string, boundKey: string, hostId: string) {
        const r = await this.db.query(`UPDATE runtime.runtime_pool_demand SET host_id = $3 WHERE pool_id = $1 AND bound_key = $2 AND host_id IS NULL`, [poolId, boundKey, hostId]);
        return r.rowCount === 1;
    }

    async demandLive(poolId: string, boundKey: string) {
        const r = await this.db.query(`SELECT 1 FROM runtime.runtime_pool_demand WHERE pool_id = $1 AND bound_key = $2 AND failed_at IS NULL AND expires_at > now()`, [poolId, boundKey]);
        return (r.rowCount ?? 0) > 0;
    }

    async failDemand(poolId: string, boundKey: string, failure: HostFailure) {
        await this.db.query(`UPDATE runtime.runtime_pool_demand SET failed_at = COALESCE(failed_at, now()), failure = COALESCE(failure, $3) WHERE pool_id = $1 AND bound_key = $2`, [poolId, boundKey, failure]);
    }

    async insertHost(h: Omit<HostRow, 'state' | 'providerId'> & { usdPerHour?: number }) {
        const r = await this.db.query(
            `INSERT INTO runtime.runtime_hosts (host_id, pool_id, provider, state, bound_key, organization_id, usd_per_hour) VALUES ($1, $2, $3, 'requested', $4, $5, $6) ON CONFLICT DO NOTHING`,
            [h.hostId, h.poolId, h.provider, h.boundKey, h.organizationId, h.usdPerHour ?? null],
        );
        if (r.rowCount === 1) await this.event(h.hostId, h.poolId, null, 'requested', 'demand');
    }

    async host(hostId: string) {
        const x = (await this.db.query(`SELECT * FROM runtime.runtime_hosts WHERE host_id = $1`, [hostId])).rows[0];
        return x ? rowOf(x) : null;
    }

    async moveHost(hostId: string, to: HostState, reason: HostReason, patch: { providerId?: string; lastError?: string } = {}) {
        const r = await this.db.query(
            `WITH prev AS (SELECT host_id, pool_id, state FROM runtime.runtime_hosts WHERE host_id = $1 FOR UPDATE)
             UPDATE runtime.runtime_hosts h SET state = $2, provider_id = COALESCE($3, h.provider_id), last_error = COALESCE($4, h.last_error), updated_at = now(),
               ready_at = CASE WHEN $2 = 'ready' THEN COALESCE(h.ready_at, now()) ELSE h.ready_at END,
               terminated_at = CASE WHEN $2 = 'terminated' THEN now() ELSE h.terminated_at END
              FROM prev WHERE h.host_id = prev.host_id AND prev.state <> 'terminated' AND prev.state IS DISTINCT FROM $2
             RETURNING prev.pool_id, prev.state AS from_state`,
            [hostId, to, patch.providerId ?? null, patch.lastError ?? null],
        );
        const moved = r.rows[0];
        if (moved) await this.event(hostId, moved.pool_id, moved.from_state, to, reason, patch.lastError);
    }

    async liveHosts(poolId?: string) {
        const r = await this.db.query(`SELECT * FROM runtime.runtime_hosts WHERE state <> 'terminated' AND ($1::text IS NULL OR pool_id = $1) ORDER BY created_at`, [poolId ?? null]);
        return r.rows.map(rowOf);
    }

    async hostCell(hostId: string) {
        const r = await this.db.query(
            `SELECT c.cell_id, (s.cell_id IS NOT NULL AND s.disconnected_at IS NULL AND s.last_heartbeat_at > now() - interval '30 seconds') AS connected
               FROM runtime.runtime_cells c LEFT JOIN runtime.runtime_cell_sessions s ON s.cell_id = c.cell_id
              WHERE c.host_id = $1 AND c.status <> 'revoked' LIMIT 1`,
            [hostId],
        );
        return r.rows[0] ? { cellId: r.rows[0].cell_id as string, connected: r.rows[0].connected === true } : null;
    }

    async liveClaimsOnHost(hostId: string) {
        const r = await this.db.query(
            `SELECT count(*)::int AS n FROM runtime.runtime_claims k JOIN runtime.runtime_cells c ON c.cell_id = k.cell_id
              WHERE c.host_id = $1 AND k.released_at IS NULL AND k.state = ANY($2::text[]) AND k.hard_expires_at > now()`,
            [hostId, [...LIVE_CLAIM_STATES]],
        );
        return Number(r.rows[0]?.n ?? 0);
    }

    private async event(hostId: string, poolId: string, from: string | null, to: string, reason: HostReason, detail?: string) {
        await this.db.query(`INSERT INTO runtime.runtime_host_events (host_id, pool_id, from_state, to_state, reason, detail) VALUES ($1, $2, $3, $4, $5, $6)`, [hostId, poolId, from, to, reason, detail ?? null]);
    }
}

const rowOf = (x: any): HostRow => ({
    hostId: x.host_id,
    poolId: x.pool_id,
    provider: x.provider,
    providerId: x.provider_id ?? null,
    state: x.state,
    boundKey: x.bound_key ?? null,
    organizationId: x.organization_id ?? null,
});
