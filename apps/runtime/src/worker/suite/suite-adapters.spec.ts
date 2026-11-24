import type { PoolView } from '@libs/runtime/placement/candidate-pools';

import type { SuiteShardHost } from '../../shared/persistence/suite-demand';
import { mainHistoryOf, PlacementSuiteDemand } from './suite-adapters';

const pool = (over: Partial<PoolView>): PoolView => ({ poolId: 'boat-1', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', weight: 1, labels: {}, cordoned: false, scalable: true, ...over });

function world(pools: PoolView[], status: SuiteShardHost[] = []) {
    const requests: Array<Record<string, unknown>> = [];
    const ended: string[] = [];
    const demand = {
        request: async (d: Record<string, unknown>) => void requests.push(d),
        status: async () => status,
        end: async (_org: string, run: string) => void ended.push(run),
    };
    const adapter = new PlacementSuiteDemand(demand as never, { list: async () => pools }, { organizationId: 'org-a', suiteRunId: 'run-1' });
    return { adapter, requests, ended };
}
const ask = { organizationId: 'org-a', environmentId: 'env-1', suiteRunId: 'run-1', shards: [0, 1] };

describe('the host demand of a suite run', () => {
    it('writes one demand per shard on the perRun pool placement would choose, the pool a claim of its shard goes to', async () => {
        const w = world([pool({ poolId: 'static-1', provider: 'static', lifecycle: 'pooled' }), pool({ poolId: 'boat-1' })]);
        await w.adapter.request(ask);
        expect(w.requests).toEqual([{ poolId: 'boat-1', organizationId: 'org-a', environmentId: 'env-1', suiteRunId: 'run-1', shards: [0, 1] }]);
    });

    it('reads the shard states the fleet and the cells report, and ends the run demand', async () => {
        const w = world([pool({})], [{ shard: 0, state: 'ready' }, { shard: 1, state: 'starting' }]);
        await w.adapter.request(ask);
        expect(await w.adapter.status()).toEqual([{ shard: 0, state: 'ready' }, { shard: 1, state: 'starting' }]);
        await w.adapter.end();
        expect(w.ended).toEqual(['run-1']);
    });

    it('with no perRun pool for this org every asked shard is failed at once, so the engine does not wait ten minutes for a host that cannot come', async () => {
        const w = world([pool({ scope: 'org:org-b' }), pool({ poolId: 'static-1', provider: 'static', lifecycle: 'pooled' })]);
        await w.adapter.request(ask);
        expect(w.requests).toEqual([]);
        expect(await w.adapter.status()).toEqual([
            { shard: 0, state: 'failed', failure: 'no_pool' },
            { shard: 1, state: 'failed', failure: 'no_pool' },
        ]);
    });
});

describe('the history of main a suite run counts drift in', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    it('is main alone when the merge base is main: no drift', () => {
        expect(mainHistoryOf({ mainSha: A, mergeBase: A })).toEqual([A]);
    });
    it('puts the merge base one commit behind main when they differ: the drift is at least one, never claimed zero', () => {
        expect(mainHistoryOf({ mainSha: A, mergeBase: B })).toEqual([A, B]);
    });
    it('is main alone for a baseline, which has no merge base', () => {
        expect(mainHistoryOf({ mainSha: A })).toEqual([A]);
    });
});
