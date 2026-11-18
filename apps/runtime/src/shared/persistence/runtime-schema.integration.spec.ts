import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';

import { ensureRuntimeSchema, type RuntimeMigration } from './runtime-schema';

// Opt-in: RUNTIME_IT_DATABASE_URL (see pg-hub-store.integration.spec.ts). The migration runner itself, on a
// database of its own with migrations of the test's: never the Runtime's list.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'schema_runner');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('ensureRuntimeSchema (integration, real Postgres)', () => {
    let a: Pool;
    let b: Pool;

    beforeAll(async () => {
        await database.create();
        a = new Pool({ connectionString: url, max: 2 });
        b = new Pool({ connectionString: url, max: 2 });
    });

    afterAll(async () => {
        await a?.end();
        await b?.end();
        await database.drop();
    });

    const validity = async (name: string) =>
        (
            await a.query(
                `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'runtime' AND c.relname = $1`,
                [name],
            )
        ).rows[0]?.indisvalid;

    it('builds a concurrent index while another process waits for the migration lock, and both boot', async () => {
        const migrations: RuntimeMigration[] = [
            { version: 1, name: 'table', sql: `CREATE TABLE runtime.big (id bigserial PRIMARY KEY, at timestamptz NOT NULL); INSERT INTO runtime.big (at) SELECT now() FROM generate_series(1, 20000); SELECT pg_sleep(0.3)` },
            { version: 2, name: 'index', concurrentIndexes: [{ name: 'big_at_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS big_at_brin ON runtime.big USING brin (at)' }] },
        ];
        // The second process asks for the lock while the first one holds it (the sleep) and then builds the index:
        // a blocking pg_advisory_lock there deadlocked with the build ("deadlock detected" in the waiter).
        const results = await Promise.all([ensureRuntimeSchema(a, migrations), new Promise((r) => setTimeout(r, 20)).then(() => ensureRuntimeSchema(b, migrations))]);
        expect(results.flat().sort()).toEqual([1, 2]);
        expect(await validity('big_at_brin')).toBe(true);
        expect(await ensureRuntimeSchema(b, migrations)).toEqual([]);
    });

    it('drops an index a cut build left INVALID and builds it again', async () => {
        await a.query(`CREATE TABLE runtime.dup (k int); INSERT INTO runtime.dup VALUES (1), (1)`);
        // A unique build over duplicates fails and leaves the index INVALID, as a build cut half way does.
        await expect(a.query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_idx ON runtime.dup (k)')).rejects.toThrow();
        expect(await validity('dup_k_idx')).toBe(false);
        await a.query(`DELETE FROM runtime.dup WHERE ctid IN (SELECT ctid FROM runtime.dup LIMIT 1)`);
        const migrations: RuntimeMigration[] = [{ version: 3, name: 'unique', concurrentIndexes: [{ name: 'dup_k_idx', sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dup_k_idx ON runtime.dup (k)' }] }];
        expect(await ensureRuntimeSchema(a, migrations)).toEqual([3]);
        expect(await validity('dup_k_idx')).toBe(true);
    });
});
