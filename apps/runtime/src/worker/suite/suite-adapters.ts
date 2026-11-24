import { candidatePools } from '@libs/runtime/placement/candidate-pools';

import type { HostPoolReader } from '../../shared/persistence/host-pools';
import type { PgSuiteDemand, SuiteShardHost } from '../../shared/persistence/suite-demand';
import type { SuiteHostDemand } from './suite-engine';

/**
 * The engine's host demand (`SuiteHostDemand`) over `PgSuiteDemand` for one suite run: the pool a demand row names is the
 * perRun pool placement chooses for a claim of the suite's shards (the first candidate, as the cell directory reads it), so
 * the host the fleet starts is the one the claim is reserved on. No perRun pool admits the org: nothing is written and every
 * asked shard reads `failed`, because a host that cannot come is not waited for.
 */
export class PlacementSuiteDemand implements SuiteHostDemand {
    private noPool: number[] | undefined;

    constructor(
        private readonly demand: Pick<PgSuiteDemand, 'request' | 'status' | 'end'>,
        private readonly pools: Pick<HostPoolReader, 'list'>,
        private readonly scope: { organizationId: string; suiteRunId: string },
    ) {}

    async request(d: { organizationId: string; environmentId: string; suiteRunId: string; shards: readonly number[] }): Promise<void> {
        const placement = candidatePools(await this.pools.list(), { organizationId: d.organizationId, consumer: 'suite', suiteRunId: d.suiteRunId, shard: d.shards[0] ?? 0 });
        const first = placement?.pools[0];
        if (!first || !placement.perRun.includes(first)) {
            this.noPool = [...new Set([...(this.noPool ?? []), ...d.shards])].sort((a, b) => a - b);
            return;
        }
        await this.demand.request({ poolId: first, ...d });
    }

    async status(): Promise<SuiteShardHost[]> {
        if (this.noPool) return this.noPool.map((shard) => ({ shard, state: 'failed' as const, failure: 'no_pool' }));
        return this.demand.status(this.scope.organizationId, this.scope.suiteRunId);
    }

    async end(): Promise<void> {
        await this.demand.end(this.scope.organizationId, this.scope.suiteRunId);
    }
}

/**
 * Main's commits as the classifier counts drift in them (docs/runtime/e2e-suites.md 8.2), head first. The worker holds no Git
 * history, so it knows only whether the merge base is main's head: when it is not, the base is put one commit behind, which
 * counts a drift of at least one and never claims zero. A real count needs a commit listing the product does not hand over yet.
 */
export function mainHistoryOf(r: { mainSha: string; mergeBase?: string }): string[] {
    return r.mergeBase && r.mergeBase !== r.mainSha ? [r.mainSha, r.mergeBase] : [r.mainSha];
}
