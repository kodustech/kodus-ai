import type { Pool } from 'pg';

import { ensureRuntimeSchema, MIGRATION_LOCK_POLL_MS } from './runtime-schema';

describe('ensureRuntimeSchema', () => {
    const poolOf = (fails: (sql: string) => boolean, lockFreeAfter = 0) => {
        const released: Array<unknown> = [];
        const sqls: string[] = [];
        let tries = 0;
        const client = {
            query: async (sql: string) => {
                sqls.push(sql);
                if (fails(sql)) throw new Error('query failed');
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: tries++ >= lockFreeAfter }] };
                return { rows: [] };
            },
            release: (destroy?: unknown) => void released.push(destroy),
        };
        return { pool: { connect: async () => client } as unknown as Pool, released, sqls };
    };
    const migrations = [{ version: 1, name: 'one', sql: 'SELECT 1' }];

    it('gives the connection back to the pool once the migration lock is released', async () => {
        const { pool, released } = poolOf(() => false);
        await expect(ensureRuntimeSchema(pool, migrations)).resolves.toEqual([1]);
        expect(released).toEqual([undefined]);
    });

    it('destroys the connection when the migration lock could not be released, so no pooled session keeps it', async () => {
        const { pool, released } = poolOf((sql) => sql.includes('pg_advisory_unlock'));
        await expect(ensureRuntimeSchema(pool, migrations)).resolves.toEqual([1]);
        expect(released).toEqual([true]);
    });

    // A session blocked in pg_advisory_lock holds a snapshot, and CREATE INDEX CONCURRENTLY in the holder waits for it.
    it('waits for another process holding the migration lock by asking again, never by blocking on it', async () => {
        const { pool, sqls } = poolOf(() => false, 2);
        const slept: number[] = [];
        await expect(ensureRuntimeSchema(pool, migrations, async (ms) => void slept.push(ms))).resolves.toEqual([1]);
        expect(slept).toEqual([MIGRATION_LOCK_POLL_MS, MIGRATION_LOCK_POLL_MS]);
        expect(sqls.some((s) => /pg_advisory_lock\(/.test(s))).toBe(false);
    });

    it('refuses a concurrent index whose sql does not build it concurrently under its own name', async () => {
        const { pool } = poolOf(() => false);
        const bad = [{ version: 1, name: 'ix', concurrentIndexes: [{ name: 'runtime_x_idx', sql: 'CREATE INDEX IF NOT EXISTS runtime_x_idx ON runtime.x (a)' }] }];
        await expect(ensureRuntimeSchema(pool, bad)).rejects.toThrow(/CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_x_idx/);
    });
});
