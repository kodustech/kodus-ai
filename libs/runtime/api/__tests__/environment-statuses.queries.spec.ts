import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { EnvironmentViewBuilder } from '../application/use-cases/environment-view';
import { ListEnvironmentStatusesUseCase } from '../application/use-cases/list-environment-statuses.use-case';
import { ListRuntimeEnvironmentsUseCase } from '../application/use-cases/list-environments.use-case';
import type { EnvironmentSetupStatus, ProductEnvironment } from '../domain/ports';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { clock, config, counted, InMemoryEnvironmentRepositories, NOW, ORG, run, storeWith, TEAM, user } from './fixtures';

// WP1: while a setup runs, the screens poll. They polled GET /runtime/environments
// every 3 s, which builds every environment's view (its Runs of the week, its
// setup, its repositories, its build cache). Measured with counted stores for
// 50 environments, 10 of them setting up, for a scoped viewer: 243 reads per
// poll (193 once the scope is read in one query). The status route answers the
// same question (has anything moved?) in 3 reads.

const env = (i: number): ProductEnvironment => ({
    environmentId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: `repo-${i}`,
    repositoryName: `acme/repo-${i}`,
    state: i < 10 ? 'setup_requested' : 'active',
    setupRequestedAt: NOW.toISOString(),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
});

const setupOf = (e: ProductEnvironment, i: number): EnvironmentSetupRecord =>
    ({
        environmentId: e.environmentId,
        organizationId: ORG,
        repositoryId: e.repositoryId,
        key: `k-${i}`,
        state: i < 10 ? 'setting_up' : 'active',
        steps: [],
        blockers: [],
        requestedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        ...(i < 10 ? { progress: { phases: [], lines: ['building'], updatedAt: '2026-10-29T12:00:05.000Z' } } : {}),
    }) as EnvironmentSetupRecord;

async function fixture(count: number) {
    const envs = Array.from({ length: count }, (_, i) => env(i));
    const setups = new Map(envs.map((e, i) => [e.environmentId, setupOf(e, i)]));
    const environments = counted({
        listByOrganization: async () => envs,
        get: async (_o: string, id: string) => envs.find((e) => e.environmentId === id) ?? null,
        findByRepository: async (_o: string, repositoryId: string) => envs.find((e) => e.repositoryId === repositoryId) ?? null,
    });
    const runs = counted(await storeWith(...envs.map((e) => run({ environmentId: e.environmentId, repositoryId: e.repositoryId }))));
    const setupReader = counted({
        get: async (_o: string, id: string) => setups.get(id) ?? null,
        statuses: async (_o: string, ids: readonly string[]): Promise<EnvironmentSetupStatus[]> =>
            ids.map((id) => setups.get(id)!).map((r) => ({ environmentId: r.environmentId, state: r.state, requestedAt: r.requestedAt, updatedAt: r.updatedAt, ...(r.progress ? { progressAt: r.progress.updatedAt } : {}) })),
    });
    const membership = counted(new InMemoryEnvironmentRepositories(envs));
    const egress = counted({ blockedForRuns: async () => [], approvals: async () => [] });
    const evictions = counted({ evictions: async () => [] });
    const builder = new EnvironmentViewBuilder(
        environments.store as never,
        runs.store,
        egress.store,
        clock,
        setupReader.store,
        config(),
        undefined,
        new RuntimeEnvironmentMembers(environments.store, membership.store),
        evictions.store,
    );
    const scope = envs.map((e) => e.repositoryId);
    const authorization = { ensure: async () => undefined, getRepositoryScope: async () => scope };
    const reads = () => environments.calls.length + runs.calls.length + setupReader.calls.length + membership.calls.length + egress.calls.length + evictions.calls.length;
    const reset = () => [environments, runs, setupReader, membership, egress, evictions].forEach((c) => c.calls.splice(0));
    return {
        list: new ListRuntimeEnvironmentsUseCase(builder, authorization),
        status: new ListEnvironmentStatusesUseCase(builder, authorization),
        reads,
        reset,
    };
}

describe('GET /runtime/environments/status', () => {
    it('answers in 3 reads whatever the number of environments, where the list reads each one', async () => {
        const f = await fixture(50);
        await f.list.execute({ user: user(Role.CONTRIBUTOR) });
        const listReads = f.reads();
        f.reset();
        const statuses = await f.status.execute({ user: user(Role.CONTRIBUTOR) });
        expect(f.reads()).toBe(3);
        expect(listReads).toBe(193);

        const small = await fixture(5);
        await small.status.execute({ user: user(Role.CONTRIBUTOR) });
        expect(small.reads()).toBe(3);

        // What it answers is what the list shows for the same environments.
        expect(statuses).toHaveLength(50);
        expect(statuses[0]).toEqual({
            environmentId: env(0).environmentId,
            state: 'setting_up',
            setup: { state: 'setting_up', requestedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), progress: { updatedAt: '2026-10-29T12:00:05.000Z' } },
            updatedAt: env(0).updatedAt,
        });
        expect(statuses[20]).toMatchObject({ state: 'active', setup: { state: 'active' } });
    });

    it('lists only the environments the caller reads whole, and none for a caller with no repository', async () => {
        const f = await fixture(3);
        const builder = (f.status as unknown as { reader: EnvironmentViewBuilder }).reader;
        const scoped = new ListEnvironmentStatusesUseCase(builder, { ensure: async () => undefined, getRepositoryScope: async () => ['repo-1'] });
        expect((await scoped.execute({ user: user(Role.CONTRIBUTOR) })).map((s) => s.environmentId)).toEqual([env(1).environmentId]);
        const none = new ListEnvironmentStatusesUseCase(builder, { ensure: async () => undefined, getRepositoryScope: async () => [] });
        expect(await none.execute({ user: user(Role.CONTRIBUTOR) })).toEqual([]);
    });
});
