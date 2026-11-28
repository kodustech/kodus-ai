import { randomUUID } from 'crypto';

import { EnvironmentRepositoryConflictError, type EnvironmentRepository, type EnvironmentRepositoryStore } from '../domain/ports';

// What every EnvironmentRepositoryStore does, run on the in-memory store
// (environment-repositories.store.spec.ts) and on Postgres
// (typeorm-runtime-product.stores.integration.spec.ts), so the two keep the
// same semantics.

export interface EnvironmentRepositoryStoreUnderTest {
    store: EnvironmentRepositoryStore;
    /** Creates an environment of that org and returns its id. */
    environment(organizationId: string): Promise<string>;
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const row = (environmentId: string, patch: Partial<EnvironmentRepository> = {}): Omit<EnvironmentRepository, 'createdAt' | 'updatedAt'> => ({
    environmentId,
    organizationId: ORG_A,
    repositoryId: randomUUID(),
    repositoryName: 'acme/shop',
    fullName: 'acme/shop',
    role: 'member',
    alias: 'shop',
    triggers: true,
    pairBranches: false,
    ...patch,
});

export function describeEnvironmentRepositoryStore(name: string, setup: () => EnvironmentRepositoryStoreUnderTest) {
    describe(`EnvironmentRepositoryStore (${name})`, () => {
        it('lists the primary first, then the members by alias', async () => {
            const { store, environment } = setup();
            const env = await environment(ORG_A);
            await store.add(row(env, { alias: 'web', repositoryName: 'acme/web' }));
            const primary = await store.add(row(env, { role: 'primary', alias: 'shop' }));
            await store.add(row(env, { alias: 'billing', repositoryName: 'acme/billing', triggers: false, pairBranches: true }));
            const listed = await store.listByEnvironment(ORG_A, env);
            expect(listed.map((r) => [r.alias, r.role])).toEqual([
                ['shop', 'primary'],
                ['billing', 'member'],
                ['web', 'member'],
            ]);
            expect(listed[1]).toMatchObject({ triggers: false, pairBranches: true, organizationId: ORG_A, environmentId: env });
            expect(primary).toMatchObject({ role: 'primary', triggers: true, pairBranches: false });
            expect(typeof primary!.createdAt).toBe('string');
        });

        it('the batch reads answer what the single reads answer, org-scoped', async () => {
            const { store, environment } = setup();
            const [a, b] = [await environment(ORG_A), await environment(ORG_A)];
            const shared = randomUUID();
            await store.add(row(a, { role: 'primary', alias: 'shop' }));
            await store.add(row(a, { repositoryId: shared, alias: 'web' }));
            await store.add(row(b, { repositoryId: shared, role: 'primary', alias: 'web' }));
            const byEnv = await store.listByEnvironments!(ORG_A, [a, b]);
            expect(byEnv.filter((r) => r.environmentId === a)).toEqual(await store.listByEnvironment(ORG_A, a));
            expect(byEnv.filter((r) => r.environmentId === b)).toEqual(await store.listByEnvironment(ORG_A, b));
            expect(await store.listByRepositories!(ORG_A, [shared])).toEqual(await store.listByRepository(ORG_A, shared));
            expect(await store.listByEnvironments!(ORG_B, [a, b])).toEqual([]);
            expect(await store.listByRepositories!(ORG_B, [shared])).toEqual([]);
            expect(await store.listByEnvironments!(ORG_A, [])).toEqual([]);
        });

        it('another org reads, adds, changes and removes none of an environment', async () => {
            const { store, environment } = setup();
            const env = await environment(ORG_A);
            const member = await store.add(row(env));
            expect(await store.listByEnvironment(ORG_B, env)).toEqual([]);
            expect(await store.listByRepository(ORG_B, member!.repositoryId)).toEqual([]);
            expect(await store.add(row(env, { organizationId: ORG_B, alias: 'other' }))).toBeNull();
            expect(await store.update(ORG_B, env, member!.repositoryId, { triggers: false })).toBeNull();
            expect(await store.remove(ORG_B, env, member!.repositoryId)).toBe(false);
            expect(await store.listByEnvironment(ORG_A, env)).toEqual([expect.objectContaining({ repositoryId: member!.repositoryId, triggers: true })]);
            // An environment that does not exist takes no repository, and an id that is not one reads as empty.
            expect(await store.add(row(randomUUID()))).toBeNull();
            expect(await store.listByEnvironment(ORG_A, 'not-a-uuid')).toEqual([]);
        });

        it('is idempotent on the environment and repository, and refuses a second primary or a taken alias', async () => {
            const { store, environment } = setup();
            const env = await environment(ORG_A);
            const first = await store.add(row(env, { role: 'primary', alias: 'shop' }));
            // The same repository again: the row as it was, whatever the second call says.
            expect(await store.add({ ...row(env), repositoryId: first!.repositoryId, alias: 'renamed', role: 'member' })).toEqual(first);
            await expect(store.add(row(env, { role: 'primary', alias: 'two' }))).rejects.toEqual(new EnvironmentRepositoryConflictError('primary'));
            await expect(store.add(row(env, { alias: 'shop' }))).rejects.toEqual(new EnvironmentRepositoryConflictError('alias'));
            await expect(store.add(row(env, { alias: 'Not An Alias' }))).rejects.toThrow('invalid repository alias');
            expect(await store.listByEnvironment(ORG_A, env)).toHaveLength(1);
        });

        it('a repository may be a member of several environments', async () => {
            const { store, environment } = setup();
            const shared = randomUUID();
            const one = await environment(ORG_A);
            const two = await environment(ORG_A);
            await store.add(row(one, { repositoryId: shared, alias: 'billing' }));
            await store.add(row(two, { repositoryId: shared, alias: 'billing' }));
            expect((await store.listByRepository(ORG_A, shared)).map((r) => r.environmentId)).toEqual([one, two]);
        });

        it('changes the given fields together and keeps the others; an alias taken is refused', async () => {
            const { store, environment } = setup();
            const env = await environment(ORG_A);
            await store.add(row(env, { role: 'primary', alias: 'shop' }));
            const member = await store.add(row(env, { alias: 'billing' }));
            const changed = await store.update(ORG_A, env, member!.repositoryId, { triggers: false, pairBranches: true });
            expect(changed).toMatchObject({ alias: 'billing', triggers: false, pairBranches: true, role: 'member' });
            expect(await store.update(ORG_A, env, member!.repositoryId, {})).toMatchObject({ triggers: false, pairBranches: true });
            await expect(store.update(ORG_A, env, member!.repositoryId, { alias: 'shop' })).rejects.toEqual(new EnvironmentRepositoryConflictError('alias'));
            expect(await store.update(ORG_A, env, member!.repositoryId, { alias: 'pay' })).toMatchObject({ alias: 'pay' });
            expect(await store.update(ORG_A, env, randomUUID(), { triggers: true })).toBeNull();
        });

        it('removes a member, never the primary', async () => {
            const { store, environment } = setup();
            const env = await environment(ORG_A);
            const primary = await store.add(row(env, { role: 'primary', alias: 'shop' }));
            const member = await store.add(row(env, { alias: 'billing' }));
            expect(await store.remove(ORG_A, env, primary!.repositoryId)).toBe(false);
            expect(await store.remove(ORG_A, env, member!.repositoryId)).toBe(true);
            expect(await store.remove(ORG_A, env, member!.repositoryId)).toBe(false);
            expect((await store.listByEnvironment(ORG_A, env)).map((r) => r.alias)).toEqual(['shop']);
        });
    });
}
