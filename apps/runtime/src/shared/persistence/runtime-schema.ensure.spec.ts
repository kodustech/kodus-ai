import type { Pool } from 'pg';

import { ensureRuntimeSchema } from './runtime-schema';

describe('ensureRuntimeSchema', () => {
    const poolOf = (fails: (sql: string) => boolean) => {
        const released: Array<unknown> = [];
        const client = {
            query: async (sql: string) => {
                if (fails(sql)) throw new Error('query failed');
                return { rows: [] };
            },
            release: (destroy?: unknown) => void released.push(destroy),
        };
        return { pool: { connect: async () => client } as unknown as Pool, released };
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
});
