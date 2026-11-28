import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PgEnvSessionStore } from './env-session.store';
import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';

// A database of its own, on the server the Runtime's integration suites use
// (or a dedicated one): never the product's (isolated-database.ts).
const url = process.env.ENV_SESSION_VALIDATION_IT_DATABASE_URL ?? process.env.RUNTIME_IT_DATABASE_URL;
/** An empty database with the env-session schema, released after `body`. */
async function withDatabase(body: (pool: Pool) => Promise<void>) {
    const database = isolatedDatabase(url!, 'env_session_validation');
    let pool: Pool | undefined;
    try {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 1 });
        await ensureRuntimeSchema(pool);
        await body(pool);
    } finally {
        await pool?.end();
        await database.drop();
    }
}

(url && process.env.SKIP_INTEGRATION !== 'true' ? describe : describe.skip)(
    'immutable validation session pins in real PostgreSQL',
    () => {
        it('persists the pin across store instances and refuses updates to its authority', async () => {
            await withDatabase(async (pool) => {
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
            });
        });

        it("keeps a multi-repository session's layout across store instances, and no update changes it", async () => {
            await withDatabase(async (pool) => {
                const sessionId = randomUUID();
                const layout = [
                    { repositoryId: 'repo', fullName: 'acme/shop', alias: 'shop', role: 'primary' as const, sha: 'c'.repeat(40) },
                    { repositoryId: 'repo-api', fullName: 'acme/api', alias: 'api', role: 'member' as const, sha: 'd'.repeat(40) },
                ];
                await new PgEnvSessionStore(pool).insert({
                    sessionId,
                    organizationId: 'org-fixture',
                    teamId: 'team',
                    keyId: 'key',
                    repositoryId: 'repo',
                    environmentId: 'env',
                    sha: 'c'.repeat(40),
                    repositories: layout,
                    state: 'acquiring',
                    createdAt: new Date().toISOString(),
                    lastUsedAt: new Date().toISOString(),
                });
                const another = new PgEnvSessionStore(pool);
                await another.update('org-fixture', sessionId, { state: 'ready', repositories: [layout[0]] });
                const row = await another.get('org-fixture', sessionId);
                expect(row).toMatchObject({ state: 'ready', repositories: layout });
            });
        });
    },
);
