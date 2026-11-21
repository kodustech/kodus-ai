import type { Pool } from 'pg';

import type { PoolView } from '@libs/runtime/placement/candidate-pools';

// The pools placement reads (docs/runtime/host-providers.md §5.2, §6): one
// query of runtime_host_pools, cached briefly per process. runtime-fleet
// writes the spec and status; the hub writes static pools at registration.

/** Reads the pools placement chooses among. */
export interface HostPoolReader {
    list(): Promise<PoolView[]>;
}

const LIST_POOLS_SQL = `SELECT pool_id, scope, provider, lifecycle, weight, cordoned_at, spec, status FROM runtime.runtime_host_pools`;

const ISOLATIONS = new Set(['vm', 'microvm', 'sandboxed-container']);

export function poolViewOf(row: { pool_id: string; scope: string; provider: string; lifecycle: string; weight: number; cordoned_at: Date | null; spec: any; status: any }): PoolView {
    const allowOrgs = row.spec?.admission?.allowOrgs;
    const isolation = row.spec?.labels?.isolation;
    return {
        poolId: row.pool_id,
        scope: row.scope,
        provider: row.provider,
        lifecycle: row.lifecycle === 'perRun' ? 'perRun' : 'pooled',
        weight: Number(row.weight) || 0,
        labels: ISOLATIONS.has(isolation) ? { isolation } : {},
        ...(Array.isArray(allowOrgs) && allowOrgs.every((o: unknown) => typeof o === 'string') ? { allowOrgs } : {}),
        cordoned: row.cordoned_at !== null,
        // A pool the controller never wrote a status for is scalable only when it is static (nothing to scale).
        scalable: row.provider === 'static' ? true : row.status?.scalable === true,
    };
}

export class PgHostPoolReader implements HostPoolReader {
    private cached?: { at: number; pools: PoolView[] };

    constructor(
        private readonly pool: Pick<Pool, 'query'>,
        private readonly opts: { cacheMs?: number } = {},
    ) {}

    async list(): Promise<PoolView[]> {
        const ttl = this.opts.cacheMs ?? 10_000;
        if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.pools;
        const pools = (await this.pool.query(LIST_POOLS_SQL)).rows.map(poolViewOf);
        this.cached = { at: Date.now(), pools };
        return pools;
    }
}
