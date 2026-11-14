import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { PgExternalStopReader } from '../infrastructure/pg-external-stop.reader';

const url = process.env.EXTERNAL_FINDINGS_IT_DATABASE_URL;
(url ? describe : describe.skip)(
    'external admission stop reader with real column-only PostgreSQL grants',
    () => {
        it('reads only stop authority and cannot inspect actors or change Runtime state', async () => {
            const owner = new Pool({ connectionString: url, max: 1 });
            const suffix = randomBytes(8).toString('hex');
            const role = `external_reader_${suffix}`;
            const password = randomBytes(24).toString('hex');
            const restricted = new URL(url!);
            restricted.username = role;
            restricted.password = password;
            const reader = new PgExternalStopReader(restricted.toString());
            const client = new Pool({
                connectionString: restricted.toString(),
                max: 1,
            });
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
                    expect(await idleWarning).toEqual({
                        event: 'runtime.a2a.stop_reader_unavailable',
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
                await reader.onModuleDestroy();
                await client.end();
                await owner.query('DROP SCHEMA IF EXISTS runtime CASCADE');
                await owner.query(`DROP ROLE IF EXISTS "${role}"`);
                await owner.end();
            }
        });
    },
);
