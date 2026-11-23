import { ServiceUnavailableException } from '@nestjs/common';

import { EnvironmentViewBuilder } from '../application/use-cases/environment-view';

// The dev cell's disk floor removed every environment's build state on
// 2026-11-13 and each environment still read "active": calcom's next PR built
// cold past its boot's wait with nothing on the screen to say a setup again
// would bring the cache back. The view names the eviction of the state the
// last setup left; an older one, or another cell's, is not this environment's.

const ORG = 'org-1';
const ENV = 'env-calcom';
const NOW = new Date('2026-11-13T12:00:00.000Z');

const product = { environmentId: ENV, organizationId: ORG, repositoryId: 'repo-1', repositoryName: 'acme/calcom', state: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const setup = (finishedAt: string) => ({
    environmentId: ENV,
    organizationId: ORG,
    repositoryId: 'repo-1',
    key: 'setup-1',
    state: 'active',
    steps: [],
    blockers: [],
    buildCellId: 'cell-dev',
    requestedAt: '2026-11-13T05:59:00.000Z',
    updatedAt: finishedAt,
    finishedAt,
});

const builder = (finishedAt: string, evictions: Array<{ cellId: string; evictedAt: string; freeBytes?: number; floorBytes?: number }>) =>
    new EnvironmentViewBuilder(
        { listByOrganization: async () => [product], get: async () => product } as any,
        { list: async () => [] } as any,
        { blockedForRuns: async () => [], approvals: async () => [] } as any,
        () => NOW,
        { get: async () => setup(finishedAt) } as any,
        undefined,
        undefined,
        undefined,
        { evictions: async (org: string, env: string) => (org === ORG && env === ENV ? evictions : []) },
    );

const viewOf = async (b: EnvironmentViewBuilder) => {
    const found = await b.source(ORG, ENV);
    return b.view(found!.env, found!.runs, false);
};

describe("an environment's build cache the cell evicted", () => {
    it('is named on the view, with when and on which cell, after the setup that made it', async () => {
        const view = await viewOf(builder('2026-11-13T06:34:00.000Z', [{ cellId: 'cell-dev', evictedAt: '2026-11-13T07:31:31.000Z' }]));
        expect(view.state).toBe('active');
        expect(view.buildCache).toEqual({ state: 'evicted', evictedAt: '2026-11-13T07:31:31.000Z', cellId: 'cell-dev', reason: 'disk_floor' });
    });

    // A volume under the floor dropped the cache a setup had just seeded and the next Run was cold with no word of why.
    it('carries the free space and the floor that removed it, when the cell said them', async () => {
        const GB = 2 ** 30;
        const view = await viewOf(builder('2026-11-13T06:34:00.000Z', [{ cellId: 'cell-dev', evictedAt: '2026-11-13T07:31:31.000Z', freeBytes: 8 * GB, floorBytes: 20 * GB }]));
        expect(view.buildCache).toEqual({ state: 'evicted', evictedAt: '2026-11-13T07:31:31.000Z', cellId: 'cell-dev', reason: 'disk_floor', freeBytes: 8 * GB, floorBytes: 20 * GB });
    });

    it('is not named when a setup finished after it, or it was on another cell', async () => {
        expect((await viewOf(builder('2026-11-13T08:00:00.000Z', [{ cellId: 'cell-dev', evictedAt: '2026-11-13T07:31:31.000Z' }]))).buildCache).toBeUndefined();
        expect((await viewOf(builder('2026-11-13T06:34:00.000Z', [{ cellId: 'cell-other', evictedAt: '2026-11-13T07:31:31.000Z' }]))).buildCache).toBeUndefined();
    });
});

describe('an environment whose setup cannot be read', () => {
    it('answers unavailable, not a view or blockers without a setup', async () => {
        const b = new EnvironmentViewBuilder(
            { listByOrganization: async () => [product], get: async () => product } as any,
            { list: async () => [] } as any,
            { blockedForRuns: async () => [], approvals: async () => [] } as any,
            () => NOW,
            { get: async () => Promise.reject(new Error('runtime db down')) } as any,
        );
        await expect(b.setup(ORG, ENV)).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(viewOf(b)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});
