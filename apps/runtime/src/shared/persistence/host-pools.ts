import type { Pool } from 'pg';

import { type ImageStoreConfig, ImageStoreConfigSchema } from '@libs/runtime/fleet/image-store';
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
        ...(Number(row.status?.hostClass?.memoryMb) > 0 && Number(row.status?.hostClass?.cpus) > 0 ? { hostClass: { memoryMb: Number(row.status.hostClass.memoryMb), cpus: Number(row.status.hostClass.cpus) } } : {}),
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

/**
 * A pool's `imageStore` block (docs/runtime/shared-image-store.md), as the fleet stored it in the pool's spec, cached briefly
 * per process. null: the pool has none, or it does not parse (a pool applied by a newer fleet): its claims build as before.
 */
export class PgPoolImageStores {
    private readonly cache = new Map<string, { at: number; config: ImageStoreConfig | null }>();

    constructor(
        private readonly pool: Pick<Pool, 'query'>,
        private readonly opts: { cacheMs?: number } = {},
    ) {}

    async imageStoreOf(poolId: string): Promise<ImageStoreConfig | null> {
        const hit = this.cache.get(poolId);
        if (hit && Date.now() - hit.at < (this.opts.cacheMs ?? 10_000)) return hit.config;
        const row = (await this.pool.query(`SELECT spec->'imageStore' AS image_store FROM runtime.runtime_host_pools WHERE pool_id = $1`, [poolId])).rows[0];
        const parsed = row?.image_store ? ImageStoreConfigSchema.safeParse(row.image_store) : null;
        const config = parsed?.success ? parsed.data : null;
        this.cache.set(poolId, { at: Date.now(), config });
        return config;
    }
}
