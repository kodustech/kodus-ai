import type { ListenHealth } from '@libs/core/workflow/infrastructure/cross-process-events.bridge';

import { databaseCheck } from '../checks/database.checks';
import { DoctorContext } from '../doctor.types';

const ctx = (env: Record<string, string> = {}): DoctorContext => ({
    teams: [],
    codeReviewAutomationSeeded: true,
    licensed: true,
    env: env as NodeJS.ProcessEnv,
});

const probe = (
    listen: ListenHealth,
    locksReady: () => Promise<void> = async () => undefined,
) => ({ locksReady, listen: () => listen });

const byCheck = (
    results: Awaited<ReturnType<ReturnType<typeof databaseCheck>['run']>>,
) => Object.fromEntries(results.map((r) => [r.check, r]));

describe('doctor: database behind a connection pooler', () => {
    it('a healthy install reports locks and live events as fine', async () => {
        const results = byCheck(
            await databaseCheck(
                probe({
                    status: 'delivering',
                    connection: 'db:5432/kodus (pooled)',
                }),
            ).run(ctx()),
        );

        expect(results['database.locks'].status).toBe('ok');
        expect(results['database.listen'].status).toBe('ok');
    });

    it('live events not arriving through a pooler tells the admin which variable to set', async () => {
        const results = byCheck(
            await databaseCheck(
                probe({
                    status: 'not-delivering',
                    connection: 'pgbouncer:6432/kodus (pooled)',
                }),
            ).run(ctx()),
        );

        expect(results['database.listen']).toMatchObject({
            status: 'warn',
            fix: expect.stringContaining('API_PG_DB_DIRECT_HOST'),
        });
    });

    it('a direct connection that still does not deliver is pointed at the pooler, and the doctor says so', async () => {
        const results = byCheck(
            await databaseCheck(
                probe({
                    status: 'not-delivering',
                    connection: 'pgbouncer:6432/kodus (direct)',
                }),
            ).run(
                ctx({
                    API_PG_DB_HOST: 'pgbouncer',
                    API_PG_DB_DIRECT_HOST: 'pgbouncer',
                }),
            ),
        );

        expect(results['database.listen'].fix).toMatch(
            /point it at the Postgres server, not at the pooler/,
        );
    });

    it('a missing lock table fails and asks for the migrations', async () => {
        const results = byCheck(
            await databaseCheck(
                probe({ status: 'delivering' }, async () => {
                    throw new Error(
                        'relation "kodus_workflow.distributed_locks" does not exist',
                    );
                }),
            ).run(ctx()),
        );

        expect(results['database.locks']).toMatchObject({
            status: 'fail',
            fix: expect.stringContaining('RUN_MIGRATIONS=true'),
        });
    });

    it('a malformed timeout setting fails and names it', async () => {
        const results = byCheck(
            await databaseCheck(probe({ status: 'delivering' })).run(
                ctx({ DB_STATEMENT_TIMEOUT_MS: '30s' }),
            ),
        );

        expect(results['database.config']).toMatchObject({
            status: 'fail',
            fix: expect.stringContaining('DB_STATEMENT_TIMEOUT_MS'),
        });
    });
});
