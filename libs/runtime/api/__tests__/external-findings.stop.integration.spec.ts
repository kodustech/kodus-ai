import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { PgExternalStopReader } from '../infrastructure/pg-external-stop.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';

// The reader reads runtime.runtime_stops by that name, so the suite owns a
// database of its own (isolated-database.ts) instead of a schema: the
// shared integration database's runtime schema is never touched.
const base = process.env.EXTERNAL_FINDINGS_IT_DATABASE_URL ?? process.env.RUNTIME_IT_DATABASE_URL;
const database = isolatedDatabase(base ?? '', 'external_stop');
(base && process.env.SKIP_INTEGRATION !== 'true' ? describe : describe.skip)(
    'external admission stop reader with real column-only PostgreSQL grants',
    () => {
        it('reads only stop authority and cannot inspect actors or change Runtime state', async () => {
            const suffix = randomBytes(8).toString('hex');
            const admin = new Pool({ connectionString: base, max: 1 });
            await database.create();
            const url = new URL(database.url);
            const owner = new Pool({ connectionString: url.toString(), max: 1 });
            // A connection pg is still closing is not a failure of the suite.
            owner.on('error', () => undefined);
            const role = `external_reader_${suffix}`;
            const password = randomBytes(24).toString('hex');
            const restricted = new URL(url.toString());
            restricted.username = role;
            restricted.password = password;
            const readDb = new RuntimeReadDb(restricted.toString());
            const reader = new PgExternalStopReader(readDb);
            const client = new Pool({
                connectionString: restricted.toString(),
                max: 1,
            });
            client.on('error', () => undefined);
            try {
                await owner.query('CREATE SCHEMA runtime');
                await owner.query(
                    'CREATE TABLE runtime.runtime_stops(scope text, organization_id text, requested_by text, cleared_at timestamptz)',
                );
                await owner.query(
                    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
                );
                await owner.query(`GRANT USAGE ON SCHEMA runtime TO "${role}"`);
                await owner.query(
                    `GRANT SELECT(scope,organization_id,cleared_at) ON runtime.runtime_stops TO "${role}"`,
                );
                expect(await reader.isStopped('org-a')).toBe(false);
                await owner.query(
                    "INSERT INTO runtime.runtime_stops VALUES('org','org-b','fixture-owner',NULL)",
                );
                expect(await reader.isStopped('org-a')).toBe(false);
                expect(await reader.isStopped('org-b')).toBe(true);
                await owner.query(
                    'UPDATE runtime.runtime_stops SET cleared_at=now()',
                );
                expect(await reader.isStopped('org-b')).toBe(false);
                await owner.query(
                    "INSERT INTO runtime.runtime_stops VALUES('global',NULL,'fixture-owner',NULL)",
                );
                expect(await reader.isStopped('org-a')).toBe(true);
                // Terminate only this fixture role's idle reader connection. The
                // API must contain pg's asynchronous pool error and reconnect.
                let notify!: (event: unknown) => void;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const idleWarning = new Promise<unknown>((resolve, reject) => {
                    notify = resolve;
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error('Idle pool event was not observed'),
                            ),
                        2500,
                    );
                });
                const warn = jest
                    .spyOn(Logger.prototype, 'warn')
                    .mockImplementation(notify);
                try {
                    const killed = await owner.query(
                        "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE usename=$1 AND state='idle'",
                        [role],
                    );
                    expect(killed.rows).toEqual([{ killed: true }]);
                    expect(await idleWarning).toMatchObject({
                        event: 'runtime.read_db.unavailable',
                        reason: 'idle_connection_error',
                    });
                    expect(await reader.isStopped('org-a')).toBe(true);
                } finally {
                    clearTimeout(timer);
                    warn.mockRestore();
                }
                await expect(
                    client.query(
                        'SELECT requested_by FROM runtime.runtime_stops',
                    ),
                ).rejects.toMatchObject({ code: '42501' });
                await expect(
                    client.query('DELETE FROM runtime.runtime_stops'),
                ).rejects.toMatchObject({ code: '42501' });
            } finally {
                await readDb.onModuleDestroy();
                await client.end();
                // The database outlives the suite (leased): the role's grants in it go first.
                await owner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE 'DROP OWNED BY "${role}"'; END IF; END $$`);
                await owner.end();
                await admin.query(`DROP ROLE IF EXISTS "${role}"`);
                await admin.end();
                await database.drop();
            }
        });

        // Behavior: a stop table the reader cannot read is an error, never "not stopped" (the gate fails closed),
        // and every failed read gives its connection back, so the reader answers again once the table is readable.
        it('fails closed on an unreadable stop table and answers again once it is readable', async () => {
            const unreadable = isolatedDatabase(base ?? '', 'external_stop_unreadable');
            await unreadable.create();
            const owner = new Pool({ connectionString: unreadable.url, max: 1 });
            owner.on('error', () => undefined);
            const readDb = new RuntimeReadDb(unreadable.url);
            const reader = new PgExternalStopReader(readDb);
            try {
                // More failed reads than the shared read pool holds connections (max 10): a leaked one would hang the next.
                for (let i = 0; i < 11; i++) {
                    await expect(reader.isStopped('org-a')).rejects.toMatchObject({ code: '42P01' });
                }
                await owner.query('CREATE SCHEMA runtime');
                await owner.query('CREATE TABLE runtime.runtime_stops(scope text, organization_id text, requested_by text, cleared_at timestamptz)');
                await owner.query("INSERT INTO runtime.runtime_stops VALUES('org','org-a','fixture-owner',NULL)");

                expect(await reader.isStopped('org-a')).toBe(true);
                expect(await reader.isStopped('org-b')).toBe(false);
            } finally {
                await readDb.onModuleDestroy();
                await owner.end();
                await unreadable.drop();
            }
        });
    },
);
