import { EnvironmentPullRequestGate, GATE_CACHE_TTL_MS } from './environment-pull-request.gate';

describe('EnvironmentPullRequestGate', () => {
    it('records only repositories with a Runtime environment, and caches the answer', async () => {
        let now = 0;
        const environments = { exists: jest.fn(async ({ where }: any) => where.repositoryId === 'with-env') };
        const gate = new EnvironmentPullRequestGate(environments as any, () => now);

        expect(await gate.shouldRecord({ organizationId: 'org-a', repositoryId: 'with-env' })).toBe(true);
        expect(await gate.shouldRecord({ organizationId: 'org-a', repositoryId: 'no-env' })).toBe(false);
        expect(await gate.shouldRecord({ organizationId: 'org-a', repositoryId: 'no-env' })).toBe(false);
        expect(environments.exists).toHaveBeenCalledTimes(2);
        expect(environments.exists).toHaveBeenCalledWith({ where: { organizationId: 'org-a', repositoryId: 'with-env' } });

        now += GATE_CACHE_TTL_MS + 1;
        await gate.shouldRecord({ organizationId: 'org-a', repositoryId: 'no-env' });
        expect(environments.exists).toHaveBeenCalledTimes(3);
    });
});
