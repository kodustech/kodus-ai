import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PgEnvSessionStore } from './env-session.store';

// Dedicated disposable database only: never activate against the product/runtime DB.
const url = process.env.ENV_SESSION_VALIDATION_IT_DATABASE_URL;
(url ? describe : describe.skip)(
    'immutable validation session pins in real PostgreSQL',
    () => {
        it('persists the pin across store instances and refuses updates to its authority', async () => {
            const owner = new Pool({ connectionString: url, max: 1 });
            const database = `validation_fixture_${randomBytes(8).toString('hex')}`;
            let pool: Pool | undefined;
            try {
                await owner.query(`CREATE DATABASE "${database}"`);
                const connection = new URL(url!);
                connection.pathname = `/${database}`;
                pool = new Pool({
                    connectionString: connection.toString(),
                    max: 1,
                });
                await PgEnvSessionStore.ensureSchema(pool);
                const store = new PgEnvSessionStore(pool);
                const sessionId = randomUUID();
                const snapshot = {
                    recipeSha: 'a'.repeat(40),
                    recipeDigest: 'b'.repeat(64),
                    checks: [{ name: 'Unit tests', run: 'pnpm test' }],
                };
                await store.insert({
                    sessionId,
                    organizationId: 'org-fixture',
                    teamId: 'team',
                    keyId: 'key',
                    repositoryId: 'repo',
                    environmentId: 'env',
                    sha: 'c'.repeat(40),
                    state: 'acquiring',
                    createdAt: new Date().toISOString(),
                    lastUsedAt: new Date().toISOString(),
                    validationSnapshot: snapshot,
                });
                snapshot.checks[0].run = 'mutated original object';
                const another = new PgEnvSessionStore(pool);
                expect(
                    (await another.get('org-fixture', sessionId))
                        ?.validationSnapshot?.checks[0].run,
                ).toBe('pnpm test');
                await another.update('org-fixture', sessionId, {
                    state: 'ready',
                    validationSnapshot: {
                        ...snapshot,
                        checks: [{ name: 'Unit tests', run: 'replaced' }],
                    },
                });
                expect(
                    (await another.get('org-fixture', sessionId))
                        ?.validationSnapshot?.checks[0].run,
                ).toBe('pnpm test');
                expect(await another.get('another-org', sessionId)).toBeNull();
            } finally {
                await pool?.end();
                await owner.query(`DROP DATABASE IF EXISTS "${database}"`);
                await owner.end();
            }
        });
    },
);
