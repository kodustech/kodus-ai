import { Pool } from 'pg';

import { PgRuntimeCellTokenReader } from '@libs/runtime/api/infrastructure/pg-runtime-cell.reader';
import { RuntimeReadDb } from '@libs/runtime/api/infrastructure/runtime-read-db';
import { CELL_TOKEN_TTL_MS } from '@libs/runtime/contracts/cell-token';

import { isolatedDatabase } from '../../testing/isolated-database';
import { ensureRuntimeSchema, RUNTIME_MIGRATIONS } from './runtime-schema';

// Opt-in: RUNTIME_IT_DATABASE_URL (locally postgres://runtime:runtime@localhost:5442/kodus_runtime_it).
const database = isolatedDatabase(
    process.env.RUNTIME_IT_DATABASE_URL ?? '',
    'cell_token_created_at',
);
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)(
    'cell registration tokens made before created_at existed (real Postgres)',
    () => {
        let pool: Pool;
        const org = 'org-tokens-upgrade';

        beforeAll(async () => {
            await database.create();
            pool = new Pool({ connectionString: url, max: 2 });
            // A deployment that issued tokens before migration 26 added created_at.
            await ensureRuntimeSchema(
                pool,
                RUNTIME_MIGRATIONS.filter((m) => m.version < 26),
            );
        });

        afterAll(async () => {
            await pool?.end();
            await database.drop();
        });

        it('dates them from their expiry, so the owner list of the last 24 hours leaves out a token of last week', async () => {
            const weekOld = new Date(Date.now() - 7 * 24 * 3_600_000);
            const hourOld = new Date(Date.now() - 3_600_000);
            await pool.query(
                `INSERT INTO runtime.runtime_cell_tokens (token_hash, organization_id, topology, expires_at, issued_by) VALUES
             ('h-week', $1, 'hybrid', $2, 'u-1'), ('h-hour', $1, 'self_hosted', $3, 'u-1')`,
                [
                    org,
                    new Date(weekOld.getTime() + CELL_TOKEN_TTL_MS),
                    new Date(hourOld.getTime() + CELL_TOKEN_TTL_MS),
                ],
            );

            await ensureRuntimeSchema(pool);

            const { rows } = await pool.query<{
                token_hash: string;
                created_at: Date;
            }>(
                `SELECT token_hash, created_at FROM runtime.runtime_cell_tokens WHERE organization_id = $1 ORDER BY token_hash`,
                [org],
            );
            expect(
                rows.map((r) => [r.token_hash, r.created_at.toISOString()]),
            ).toEqual([
                ['h-hour', hourOld.toISOString()],
                ['h-week', weekOld.toISOString()],
            ]);

            const readDb = new RuntimeReadDb(url);
            const reader = new PgRuntimeCellTokenReader(readDb);
            try {
                const listed = await reader.listByOrganization(
                    org,
                    new Date(Date.now() - 24 * 3_600_000),
                );
                expect(listed.map((t) => t.tokenHash)).toEqual(['h-hour']);
            } finally {
                await readDb.onModuleDestroy();
            }
        });

        it('leaves a token made after the upgrade at the time it was made', async () => {
            const before = Date.now();
            await pool.query(
                `INSERT INTO runtime.runtime_cell_tokens (token_hash, organization_id, topology, expires_at, issued_by) VALUES ('h-new', $1, 'hybrid', $2, 'u-1')`,
                [org, new Date(before + CELL_TOKEN_TTL_MS)],
            );
            const { rows } = await pool.query<{ created_at: Date }>(
                `SELECT created_at FROM runtime.runtime_cell_tokens WHERE token_hash = 'h-new'`,
            );
            expect(
                Math.abs(rows[0].created_at.getTime() - before),
            ).toBeLessThan(5_000);
        });
    },
);
