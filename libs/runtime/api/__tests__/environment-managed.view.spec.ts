import { EnvironmentViewBuilder } from '../application/use-cases/environment-view';

// The environments page lists, besides the product's environments, the ones
// only earlier Runs know (old ids with no product row). Only the first can be
// set up or configured: the view says which is which.

const ORG = 'org-1';
const NOW = new Date('2026-11-12T12:00:00.000Z');

const productRow = {
    environmentId: 'env-product',
    organizationId: ORG,
    repositoryId: 'repo-1',
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
};
const runOnly = {
    runId: 'run-1',
    environmentId: 'h1-pkg-shop-repo',
    organizationId: ORG,
    repositoryId: 'repo-1',
    repositoryName: 'acme/shop',
    state: 'no_regressions',
    requestedAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
};

const builder = () =>
    new EnvironmentViewBuilder(
        {
            listByOrganization: async () => [productRow],
            get: async (_org: string, id: string) => (id === productRow.environmentId ? productRow : null),
        } as any,
        { list: async (q: { environmentId?: string }) => [runOnly].filter((r) => !q.environmentId || r.environmentId === q.environmentId) } as any,
        { blockedForRuns: async () => [], approvals: async () => [] } as any,
        () => NOW,
    );

describe('which environments the product manages', () => {
    it('the list marks an environment of the product as managed and one only earlier Runs know as not', async () => {
        const b = builder();
        const sources = await b.sources(ORG, [runOnly as any]);
        const views = await Promise.all(sources.map((s) => b.view(s, [], false)));
        expect(Object.fromEntries(views.map((v) => [v.environmentId, v.managed]))).toEqual({
            'env-product': true,
            'h1-pkg-shop-repo': false,
        });
    });

    it('the page of an environment only earlier Runs know says it is not managed', async () => {
        const b = builder();
        const found = await b.source(ORG, 'h1-pkg-shop-repo');
        const view = await b.view(found!.env, found!.runs, false);
        expect(view.managed).toBe(false);
        const product = await b.source(ORG, 'env-product');
        expect((await b.view(product!.env, product!.runs, false)).managed).toBe(true);
    });
});
