import type { Pool } from 'pg';

import { boundKeyOfSuite } from '@libs/runtime/placement/candidate-pools';

import { recordPoolDemand } from './cell-directory';

/**
 * The demand a suite run makes on a perRun pool (docs/runtime/e2e-suites.md section 5): one `runtime_pool_demand` row
 * per shard, keyed `suite:<org>/<suiteRun>/<shard>`, so the fleet starts every host at once and each shard's cell is
 * bound to its own key. The worker writes the rows (the fleet only reads them and records a failure on them). A row
 * lives `POOL_DEMAND_TTL_SECONDS` (cell-directory.ts) unless the suite asks again, so the engine asks while the run lives, which keeps the
 * host through the gap between a shard's first pass and its re-run; `end` ends it at once.
 */
export type SuiteShardHostState = 'starting' | 'ready' | 'failed';

export interface SuiteShardHost {
    shard: number;
    state: SuiteShardHostState;
    failure?: string;
}

export class PgSuiteDemand {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** Makes or refreshes one demand row per shard; a shard whose host the fleet could not make is told by `status`. */
    async request(d: { poolId: string; organizationId: string; environmentId: string; suiteRunId: string; shards: readonly number[]; sizeMb?: number }): Promise<void> {
        for (const shard of d.shards) {
            await recordPoolDemand(this.pool, {
                poolId: d.poolId,
                boundKey: boundKeyOfSuite(d.organizationId, d.suiteRunId, shard),
                organizationId: d.organizationId,
                environmentId: d.environmentId,
                runId: d.suiteRunId,
                sizeMb: d.sizeMb,
            });
        }
    }

    /** Each shard of the run that has demand: its host's cell is connected (`ready`), the fleet failed it (`failed`), or it is on its way. */
    async status(organizationId: string, suiteRunId: string): Promise<SuiteShardHost[]> {
        const prefix = `suite:${organizationId}/${suiteRunId}/`;
        const r = await this.pool.query(
            `SELECT d.bound_key, d.failed_at, d.failure,
                    EXISTS (SELECT 1 FROM runtime.runtime_cell_sessions s WHERE s.bound_key = d.bound_key AND s.disconnected_at IS NULL) AS connected
               FROM runtime.runtime_pool_demand d
              WHERE d.organization_id = $1 AND left(d.bound_key, length($2::text)) = $2::text`,
            [organizationId, prefix],
        );
        return r.rows
            .map((x): SuiteShardHost => {
                const shard = Number((x.bound_key as string).slice(prefix.length));
                if (x.failed_at) return { shard, state: 'failed', failure: String(x.failure ?? 'failed') };
                return { shard, state: x.connected ? 'ready' : 'starting' };
            })
            .sort((a, b) => a.shard - b.shard);
    }

    /** Ends the run's demand now: the fleet retires its hosts as soon as no claim holds them. */
    async end(organizationId: string, suiteRunId: string): Promise<void> {
        const prefix = `suite:${organizationId}/${suiteRunId}/`;
        await this.pool.query(
            `UPDATE runtime.runtime_pool_demand SET expires_at = now() WHERE organization_id = $1 AND left(bound_key, length($2::text)) = $2::text AND expires_at > now()`,
            [organizationId, prefix],
        );
    }
}
