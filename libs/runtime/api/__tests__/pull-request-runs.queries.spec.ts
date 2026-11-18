import type { EnvironmentSetupState, RuntimeRunProjection } from '@libs/runtime/run';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { ListPullRequestRunsUseCase } from '../application/use-cases/pull-request-runs.use-case';
import type { ProductEnvironment } from '../domain/ports';
import type { PullRequestRef, PullRequestRunRecord, PullRequestRunsReader } from '../domain/pull-request-runs';
import { counted, InMemoryEnvironmentRepositories, ORG, run, TEAM, user } from './fixtures';

// WP3: the Runtime column of the PR list asks for 50 PRs at a time. Before,
// its environment and repository scoping read the stores once per repository,
// per environment and per Run's environment: 172 reads for the 40-repository chunk below (21 for 4).
// It now reads them a fixed number of times, whatever the chunk holds.

const env = (i: number): ProductEnvironment => ({
    environmentId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: `repo-${i}`,
    repositoryName: `acme/repo-${i}`,
    state: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
});

class Reader implements PullRequestRunsReader {
    calls = 0;
    constructor(private readonly runs: RuntimeRunProjection[]) {}
    async listForPullRequests(input: { organizationId: string; pullRequests: PullRequestRef[] }): Promise<PullRequestRunRecord[]> {
        this.calls += 1;
        return this.runs.filter((r) => input.pullRequests.some((p) => p.repositoryId === r.repositoryId && p.prNumber === r.prNumber));
    }
    async setupStates(_org: string, ids: string[]) {
        this.calls += 1;
        return new Map<string, EnvironmentSetupState>(ids.map((id) => [id, 'active']));
    }
}

async function chunk(repositories: number) {
    const envs = Array.from({ length: repositories }, (_, i) => env(i));
    const rows = new InMemoryEnvironmentRepositories(envs);
    for (const e of envs) await rows.add({ ...e, fullName: e.repositoryName, role: 'primary', alias: `repo${e.repositoryId.slice(5)}`, triggers: true, pairBranches: false });
    // Every fifth environment also holds the next repository.
    for (let i = 0; i + 1 < repositories; i += 5) {
        const next = envs[i + 1];
        await rows.add({ ...envs[i], repositoryId: next.repositoryId, repositoryName: next.repositoryName, fullName: next.repositoryName, role: 'member', alias: `m${i}`, triggers: true, pairBranches: false });
    }
    const pullRequests = Array.from({ length: 50 }, (_, i) => ({ repositoryId: `repo-${i % repositories}`, prNumber: i + 1 }));
    // One Run per PR, of the environment of the PR's repository, plus one of an environment the repository has left.
    const runs = pullRequests.map((pr) => run({ repositoryId: pr.repositoryId, prNumber: pr.prNumber, environmentId: env(Number(pr.repositoryId.slice(5))).environmentId }));
    runs.push(run({ repositoryId: 'repo-0', prNumber: 1, environmentId: 'env-gone', requestedAt: '2026-10-29T10:00:00.000Z' }));
    const byId = new Map(envs.map((e) => [e.environmentId, e]));
    const environmentStore = counted({
        listByOrganization: async () => envs,
        get: async (_o: string, id: string) => byId.get(id) ?? null,
        findByRepository: async (_o: string, repositoryId: string) => envs.find((e) => e.repositoryId === repositoryId) ?? null,
        getMany: async (_o: string, ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((e): e is ProductEnvironment => !!e),
        findByRepositories: async (_o: string, ids: readonly string[]) => envs.filter((e) => ids.includes(e.repositoryId)),
    });
    const membership = counted(rows);
    const reader = new Reader(runs);
    const scope = envs.map((e) => e.repositoryId);
    const useCase = new ListPullRequestRunsUseCase(
        reader,
        environmentStore.store,
        { listRepositories: async () => [] },
        { ensure: async () => undefined, getRepositoryScope: async () => scope },
        new RuntimeEnvironmentMembers(environmentStore.store, membership.store),
    );
    const res = await useCase.execute({ user: user(Role.CONTRIBUTOR), body: { pullRequests } });
    return { res, reads: environmentStore.calls.length + membership.calls.length + reader.calls + 1 /* the settings */ };
}

describe('POST /runtime/pull-request-runs: reads per chunk', () => {
    it('reads the stores a fixed number of times for 50 PRs, whatever the number of repositories', async () => {
        const small = await chunk(4);
        const large = await chunk(40);
        expect(large.reads).toBe(small.reads);
        expect(large.reads).toBeLessThanOrEqual(8);
        // The answer is the same as before: every PR has its environment and its latest Run.
        expect(large.res.pullRequests).toHaveLength(50);
        expect(large.res.pullRequests.every((p) => p.environment && p.latest)).toBe(true);
        // A repository in two environments lists both, the one it is the primary of first.
        const shared = large.res.pullRequests.find((p) => p.repositoryId === 'repo-1')!;
        expect(shared.environments?.map((e) => [e.name, e.role])).toEqual([
            ['acme/repo-1', 'primary'],
            ['acme/repo-0', 'member'],
        ]);
        expect(shared.environments?.[1].repositoryIds).toEqual(['repo-0', 'repo-1']);
    });
});
