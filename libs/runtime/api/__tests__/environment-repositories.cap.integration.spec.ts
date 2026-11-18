import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { MAX_WORKSPACE_REPOSITORIES } from '@libs/runtime/contracts/workspace';

import { EnvironmentRepositoryConflictError } from '../domain/ports';
import { RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel } from '../infrastructure/runtime-product.models';
import { TypeOrmEnvironmentRepositoryStore, TypeOrmProductEnvironmentStore } from '../infrastructure/typeorm-runtime-product.stores';

// The cap on an environment's repositories against real Postgres: adds that
// arrive together, each on its own connection, never leave more than the cap.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const schema = `it_runtime_env_repos_cap_${process.pid}_${Date.now()}`;

const ORG = 'org-a';
// More adds than free places (the cap less the primary), each holding a
// connection of its own: enough to race, without taking a quarter of the
// server's connections from the suites running beside it.
const CONCURRENT_ADDS = 12;

(skip ? describe.skip : describe)('environment repositories cap (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;

    beforeAll(async () => {
        admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({
            type: 'postgres',
            url,
            schema,
            entities: [RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel],
            synchronize: true,
            uuidExtension: 'pgcrypto',
            installExtensions: false,
            // One connection per add: the adds really run at the same time.
            extra: { max: CONCURRENT_ADDS },
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

    it(`adds that arrive together never leave an environment with more than ${MAX_WORKSPACE_REPOSITORIES} repositories`, async () => {
        const environments = new TypeOrmProductEnvironmentStore(source.getRepository(RuntimeEnvironmentModel));
        const store = new TypeOrmEnvironmentRepositoryStore(source.getRepository(RuntimeEnvironmentRepositoryModel), source.getRepository(RuntimeEnvironmentModel));
        const env = await environments.create({ organizationId: ORG, teamId: 'team-a', repositoryId: randomUUID(), repositoryName: 'acme/shop' });
        const base = { environmentId: env.environmentId, organizationId: ORG, triggers: true, pairBranches: false };
        await store.add({ ...base, repositoryId: env.repositoryId, repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop' });

        const results = await Promise.allSettled(
            Array.from({ length: CONCURRENT_ADDS }, (_, i) =>
                store.add({ ...base, repositoryId: randomUUID(), repositoryName: `acme/svc-${i}`, fullName: `acme/svc-${i}`, role: 'member', alias: `svc-${i}` }),
            ),
        );

        const rows = await store.listByEnvironment(ORG, env.environmentId);
        expect(rows).toHaveLength(MAX_WORKSPACE_REPOSITORIES);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_WORKSPACE_REPOSITORIES - 1);
        // Every add past the cap is refused as such, never with a database error.
        for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
            expect(r.reason).toBeInstanceOf(EnvironmentRepositoryConflictError);
            expect(r.reason.conflict).toBe('limit');
        }
    });
});
