import { pullRequestGateOf } from './runtime-pull-request-gate.module';

// The webhook gate records the pull request events of a repository that is
// only a member of an environment, not only of the environment's own one.

const table = (rows: Array<{ organizationId: string; repositoryId: string }>) => ({
    exists: async ({ where }: any) => rows.some((r) => r.organizationId === where.organizationId && r.repositoryId === where.repositoryId),
});

describe('the pull request gate the module binds', () => {
    it('records a member repository, the primary, and nothing else', async () => {
        const gate = pullRequestGateOf(table([{ organizationId: 'org-1', repositoryId: 'billing' }]) as any, table([{ organizationId: 'org-1', repositoryId: 'shop' }]) as any);
        expect(await gate.shouldRecord({ organizationId: 'org-1', repositoryId: 'billing' })).toBe(true);
        expect(await gate.shouldRecord({ organizationId: 'org-1', repositoryId: 'shop' })).toBe(true);
        expect(await gate.shouldRecord({ organizationId: 'org-1', repositoryId: 'web' })).toBe(false);
        expect(await gate.shouldRecord({ organizationId: 'org-2', repositoryId: 'billing' })).toBe(false);
    });
});
