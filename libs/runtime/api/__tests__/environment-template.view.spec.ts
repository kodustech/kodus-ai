import { EnvironmentViewBuilder } from '../application/use-cases/environment-view';

// docs/runtime/host-providers.md §8.2.2: a template stays while main moves, so the environment page must say which main commit the
// template holds and how old it is; otherwise a Run that builds a lot of new code over it has no explanation on the screen.

const ORG = 'org-1';
const ENV = 'env-shop';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const product = { environmentId: ENV, organizationId: ORG, repositoryId: 'repo-1', repositoryName: 'acme/shop', state: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };

const builder = (templates?: unknown) =>
    new EnvironmentViewBuilder(
        { listByOrganization: async () => [product], get: async () => product } as any,
        { list: async () => [] } as any,
        { blockedForRuns: async () => [], approvals: async () => [] } as any,
        () => NOW,
        { get: async () => null } as any,
        undefined,
        undefined,
        undefined,
        undefined,
        templates as any,
    );

const viewOf = async (b: EnvironmentViewBuilder) => {
    const found = await b.source(ORG, ENV);
    return b.view(found!.env, found!.runs, false);
};

describe("an environment's ready template on its page", () => {
    it('names the main commit it holds, when it was built and how many main commits came after', async () => {
        const row = { mainSha: 'a'.repeat(40), builtAt: '2026-11-20T10:00:00.000Z', commitsBehind: 12 };
        const view = await viewOf(builder({ readyFor: async (o: string, e: string) => (o === ORG && e === ENV ? row : null) }));
        expect(view.template).toEqual(row);
    });
    it('has none when the environment has no ready template', async () => {
        expect((await viewOf(builder({ readyFor: async () => null }))).template).toBeUndefined();
    });
    it('has none, and the environment still loads, when the template read fails or there is no reader', async () => {
        expect((await viewOf(builder({ readyFor: async () => { throw new Error('db down'); } }))).template).toBeUndefined();
        expect((await viewOf(builder())).template).toBeUndefined();
    });
});
