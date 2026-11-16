import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import {
    RuntimeEnvironmentModel,
    RuntimeEnvironmentRepositoryModel,
    RuntimeFindingFeedbackModel,
    RuntimeFindingIntentModel,
    RuntimeRepositorySettingsModel,
    RuntimeSettingsModel,
} from '../infrastructure/runtime-product.models';
import {
    TypeOrmEnvironmentRepositoryStore,
    TypeOrmFindingFeedbackStore,
    TypeOrmFindingIntentStore,
    TypeOrmProductEnvironmentStore,
    TypeOrmRuntimeSettingsStore,
} from '../infrastructure/typeorm-runtime-product.stores';
import { describeEnvironmentRepositoryStore } from './environment-repositories.contract';

// The product's Runtime stores against real Postgres: every read and write
// names the org, and another org's row reads as absent and is never written.
// The tables come from the entities (synchronize) in a throwaway schema.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const schema = `it_runtime_product_${process.pid}_${Date.now()}`;

const ORG_A = 'org-a';
const ORG_B = 'org-b';

(skip ? describe.skip : describe)('Runtime product stores (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;

    beforeAll(async () => {
        admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({
            type: 'postgres',
            url,
            schema,
            entities: [RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel, RuntimeSettingsModel, RuntimeRepositorySettingsModel, RuntimeFindingFeedbackModel, RuntimeFindingIntentModel],
            synchronize: true,
            uuidExtension: 'pgcrypto',
            installExtensions: false,
            extra: { max: 2 },
        });
        await source.initialize();
    });

    afterAll(async () => {
        await source?.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    describe('TypeOrmProductEnvironmentStore', () => {
        const store = () => new TypeOrmProductEnvironmentStore(source.getRepository(RuntimeEnvironmentModel));
        const create = (organizationId: string, repositoryId = randomUUID()) =>
            store().create({ organizationId, teamId: `team-${organizationId}`, repositoryId, repositoryName: 'acme/shop' });

        it('another org reads none of the environment', async () => {
            const env = await create(ORG_A);
            expect(await store().get(ORG_A, env.environmentId)).toMatchObject({ environmentId: env.environmentId, organizationId: ORG_A });
            expect(await store().get(ORG_B, env.environmentId)).toBeNull();
            expect(await store().findByRepository(ORG_B, env.repositoryId)).toBeNull();
            expect((await store().listByOrganization(ORG_B)).map((e) => e.environmentId)).not.toContain(env.environmentId);
            // An id that is not a uuid never reaches Postgres.
            expect(await store().get(ORG_A, 'not-a-uuid')).toBeNull();
        });

        it('the same repository in two orgs is two environments', async () => {
            const repo = randomUUID();
            const a = await create(ORG_A, repo);
            const b = await create(ORG_B, repo);
            expect(a.environmentId).not.toBe(b.environmentId);
            // Idempotent per org and repository.
            expect((await create(ORG_A, repo)).environmentId).toBe(a.environmentId);
        });

        it('writes all settings in one update, and never another org\'s environment', async () => {
            const env = await create(ORG_A);
            const policy = { schedule: { timezone: 'UTC', days: ['mon' as const], start: '08:00', end: '19:00' }, monthlyBudgetUsd: 10 };
            await store().updateSettings(ORG_B, env.environmentId, { diagnosticHold: true, poolSize: 3 });
            await store().markSetupRequested(ORG_B, env.environmentId, new Date());
            await store().markPoolActivity(ORG_B, env.environmentId, new Date());
            await store().setPoolApplied(ORG_B, env.environmentId, 3, { month: '2026-11', machineMinutes: 1, countedAt: new Date().toISOString() });
            const untouched = await store().get(ORG_A, env.environmentId);
            expect(untouched).toMatchObject({ diagnosticHold: false, poolSize: null, poolActivityAt: null, poolAppliedSize: null });
            expect(untouched).not.toHaveProperty('setupRequestedAt');

            await store().updateSettings(ORG_A, env.environmentId, { diagnosticHold: true, machineSize: 'medium', forkPullRequests: 'skip', poolSize: 2, poolPolicy: policy as never });
            expect(await store().get(ORG_A, env.environmentId)).toMatchObject({ diagnosticHold: true, machineSize: 'medium', forkPullRequests: 'skip', poolSize: 2, poolPolicy: policy });
            // A field left out keeps its value; an empty patch writes nothing.
            await store().updateSettings(ORG_A, env.environmentId, { poolSize: null });
            await store().updateSettings(ORG_A, env.environmentId, {});
            expect(await store().get(ORG_A, env.environmentId)).toMatchObject({ diagnosticHold: true, machineSize: 'medium', poolSize: null });
        });
    });

    describeEnvironmentRepositoryStore('TypeORM, real Postgres', () => {
        const environments = new TypeOrmProductEnvironmentStore(source.getRepository(RuntimeEnvironmentModel));
        return {
            store: new TypeOrmEnvironmentRepositoryStore(source.getRepository(RuntimeEnvironmentRepositoryModel), source.getRepository(RuntimeEnvironmentModel)),
            environment: async (organizationId: string) =>
                (await environments.create({ organizationId, teamId: `team-${organizationId}`, repositoryId: randomUUID(), repositoryName: 'acme/shop' })).environmentId,
        };
    });

    it('deleting an environment deletes its repositories', async () => {
        const environments = new TypeOrmProductEnvironmentStore(source.getRepository(RuntimeEnvironmentModel));
        const store = new TypeOrmEnvironmentRepositoryStore(source.getRepository(RuntimeEnvironmentRepositoryModel), source.getRepository(RuntimeEnvironmentModel));
        const env = await environments.create({ organizationId: ORG_A, teamId: 'team-a', repositoryId: randomUUID(), repositoryName: 'acme/shop' });
        await store.add({ environmentId: env.environmentId, organizationId: ORG_A, repositoryId: env.repositoryId, repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop', triggers: true, pairBranches: false });
        await source.getRepository(RuntimeEnvironmentModel).delete({ uuid: env.environmentId });
        expect(await store.listByEnvironment(ORG_A, env.environmentId)).toEqual([]);
    });

    describe('TypeOrmRuntimeSettingsStore', () => {
        const store = () => new TypeOrmRuntimeSettingsStore(source.getRepository(RuntimeSettingsModel), source.getRepository(RuntimeRepositorySettingsModel));

        it('another org reads none of the org or repository settings', async () => {
            const org = `org-${randomUUID()}`;
            const other = `org-${randomUUID()}`;
            await store().setTokenBudget(org, 5_000);
            await store().upsertRepository(org, { repositoryId: '42', pilot: true, whoCanAsk: 'maintainers' });
            expect(await store().getOrganization(org)).toEqual({ tokenBudgetPerDay: 5_000 });
            expect(await store().getOrganization(other)).toBeNull();
            expect(await store().listRepositories(org)).toEqual([expect.objectContaining({ repositoryId: '42', pilot: true, whoCanAsk: 'maintainers' })]);
            expect(await store().listRepositories(other)).toEqual([]);
        });

        it('the same repository in another org is its own row', async () => {
            const org = `org-${randomUUID()}`;
            const other = `org-${randomUUID()}`;
            await store().upsertRepository(org, { repositoryId: '42', pilot: true, whoCanAsk: 'maintainers' });
            await store().upsertRepository(other, { repositoryId: '42', pilot: false, whoCanAsk: 'writers' });
            expect(await store().listRepositories(org)).toEqual([expect.objectContaining({ pilot: true, whoCanAsk: 'maintainers' })]);
        });

        it('the reconciler reads only repositories in mode rules, of every org, with when their settings last changed', async () => {
            const org = `org-${randomUUID()}`;
            const other = `org-${randomUUID()}`;
            await store().upsertRepository(org, { repositoryId: 'r-rules', pilot: true, whoCanAsk: 'writers', mode: 'rules', rules: [] });
            await store().upsertRepository(org, { repositoryId: 'r-asked', pilot: true, whoCanAsk: 'writers', mode: 'on_request' });
            await store().upsertRepository(org, { repositoryId: 'r-legacy', pilot: true, whoCanAsk: 'writers' });
            await store().upsertRepository(other, { repositoryId: 'r-off', pilot: false, whoCanAsk: 'writers', mode: 'off' });
            await store().upsertRepository(other, { repositoryId: 'r-rules', pilot: true, whoCanAsk: 'writers', mode: 'rules', rules: [] });
            const before = (await store().listAutomaticAcrossOrganizations(1_000)).filter((r) => r.organizationId === org && r.repositoryId === 'r-rules')[0];
            const rows = (await store().listAutomaticAcrossOrganizations(1_000)).filter((r) => r.organizationId === org || r.organizationId === other);
            expect(rows.map((r) => [r.organizationId, r.repositoryId]).sort()).toEqual([[org, 'r-rules'], [other, 'r-rules']].sort());
            // Saving the settings again moves the time: a PR updated before it is outside the reconciler's reach.
            await new Promise((r) => setTimeout(r, 20));
            await store().upsertRepository(org, { repositoryId: 'r-rules', pilot: true, whoCanAsk: 'writers', mode: 'rules', rules: [] });
            const after = (await store().listAutomaticAcrossOrganizations(1_000)).find((r) => r.organizationId === org && r.repositoryId === 'r-rules')!;
            expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
        });
    });

    describe('TypeOrmFindingFeedbackStore', () => {
        const store = () => new TypeOrmFindingFeedbackStore(source.getRepository(RuntimeFindingFeedbackModel));

        it('another org neither reads, clears nor overwrites a vote', async () => {
            const runId = randomUUID();
            const vote = { runId, probeId: 'p-1', userId: 'u-1' };
            await store().set({ ...vote, organizationId: ORG_A, value: 'up' });
            expect(await store().listForRun(ORG_B, runId)).toEqual([]);
            await store().set({ ...vote, organizationId: ORG_B, value: null });
            // Same Run, probe and user under another org: the row stays the first org's, with its value.
            await store().set({ ...vote, organizationId: ORG_B, value: 'down' });
            expect(await store().listForRun(ORG_A, runId)).toEqual([expect.objectContaining({ organizationId: ORG_A, value: 'up' })]);
            expect(await store().listForRun(ORG_B, runId)).toEqual([]);

            await store().set({ ...vote, organizationId: ORG_A, value: 'down' });
            expect(await store().listForRun(ORG_A, runId)).toEqual([expect.objectContaining({ value: 'down' })]);
            await store().set({ ...vote, organizationId: ORG_A, value: null });
            expect(await store().listForRun(ORG_A, runId)).toEqual([]);
        });
    });

    describe('TypeOrmFindingIntentStore', () => {
        const store = () => new TypeOrmFindingIntentStore(source.getRepository(RuntimeFindingIntentModel));

        it('another org neither reads, clears nor overwrites a mark', async () => {
            const runId = randomUUID();
            await store().set({ organizationId: ORG_A, runId, probeId: 'p-1', userId: 'u-1', intended: true });
            expect(await store().listForRun(ORG_B, runId)).toEqual([]);
            await store().set({ organizationId: ORG_B, runId, probeId: 'p-1', userId: 'u-2', intended: false });
            await store().set({ organizationId: ORG_B, runId, probeId: 'p-1', userId: 'u-2', intended: true });
            expect(await store().listForRun(ORG_A, runId)).toEqual([expect.objectContaining({ organizationId: ORG_A, userId: 'u-1' })]);
            expect(await store().listForRun(ORG_B, runId)).toEqual([]);

            // The latest marker of the same org wins.
            await store().set({ organizationId: ORG_A, runId, probeId: 'p-1', userId: 'u-3', intended: true });
            expect(await store().listForRun(ORG_A, runId)).toEqual([expect.objectContaining({ userId: 'u-3' })]);
        });
    });
});
