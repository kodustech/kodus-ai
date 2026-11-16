import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { RunTargetConflictError, type RunTarget } from '../domain/run-target';
import { RuntimeRunTargetModel } from './runtime-run-target.model';
import { TypeOrmRunTargetStore } from './typeorm-run-target.store';

// The store the API and the publisher are wired with, against real Postgres.
// The table comes from the entity (synchronize) in a throwaway schema.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const schema = `it_typeorm_targets_${process.pid}_${Date.now()}`;

const target = (patch: Partial<RunTarget> = {}): RunTarget => ({
    runId: randomUUID(),
    attempt: 1,
    organizationId: 'org-a',
    teamId: 'team-a',
    repositoryId: '42',
    repositoryName: 'shop',
    repositoryFullName: 'acme/shop',
    platform: PlatformType.GITHUB,
    pullRequestNumber: 7,
    headSha: 'a'.repeat(40),
    ...patch,
});

const workspace: RunTarget['workspace'] = [
    { repositoryId: '42', alias: 'shop', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), source: 'pull_request' },
    { repositoryId: '43', alias: 'billing', baseSha: 'c'.repeat(40), headSha: 'c'.repeat(40), source: 'default_branch' },
    { repositoryId: '44', alias: 'web', baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), source: 'paired', pairedPrNumber: 9 },
];

(skip ? describe.skip : describe)('TypeOrmRunTargetStore (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;
    let store: TypeOrmRunTargetStore;

    beforeAll(async () => {
        admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({
            type: 'postgres',
            url,
            schema,
            entities: [RuntimeRunTargetModel],
            synchronize: true,
            uuidExtension: 'pgcrypto',
            installExtensions: false,
            extra: { max: 2 },
        });
        await source.initialize();
        store = new TypeOrmRunTargetStore(source.getRepository(RuntimeRunTargetModel));
    });

    afterAll(async () => {
        await source?.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    it('records a target once and accepts the same target again', async () => {
        const t = target();
        await store.record(t);
        await store.record(t);
        expect(await store.get(t.runId)).toEqual(t);
        expect(await store.get(randomUUID())).toBeNull();
    });

    it('never lets another org (or another PR) take over a Run that already has a target', async () => {
        const t = target({ repositoryFullName: undefined });
        await store.record(t);
        await expect(store.record({ ...t, organizationId: 'org-b', teamId: 'team-b' })).rejects.toBeInstanceOf(RunTargetConflictError);
        await expect(store.record({ ...t, pullRequestNumber: 8 })).rejects.toBeInstanceOf(RunTargetConflictError);
        expect(await store.get(t.runId)).toEqual(t);
    });

    it('keeps the workspace of a multi-repository Run, and another workspace is another target', async () => {
        const t = target({ workspace });
        await store.record(t);
        await store.record({ ...t, workspace: workspace!.map((r) => ({ ...r })) });
        expect(await store.get(t.runId)).toEqual(t);
        await expect(store.record({ ...t, workspace: workspace!.slice(0, 2) })).rejects.toBeInstanceOf(RunTargetConflictError);
        const single = target();
        await store.record(single);
        expect(await store.get(single.runId)).not.toHaveProperty('workspace');
    });

    it('a read scoped to another org finds nothing', async () => {
        const t = target();
        await store.record(t);
        expect(await store.get(t.runId, { organizationId: 'org-a' })).toEqual(t);
        expect(await store.get(t.runId, { organizationId: 'org-b' })).toBeNull();
    });
});
