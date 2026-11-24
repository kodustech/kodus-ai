import {
    DatabaseSettingError,
    describeConnection,
    resolveDirectConnection,
    resolveSessionTimeouts,
} from '@libs/core/infrastructure/database/typeorm/postgres-connection-env';
import type { ListenHealth } from '@libs/core/workflow/infrastructure/cross-process-events.bridge';

import { DoctorCheck, DoctorContext, DoctorResult } from '../doctor.types';

export interface DatabaseProbe {
    /** Resolves when the lock table answers; rejects with the reason. */
    locksReady(): Promise<void>;
    /** LISTEN delivery as the API's event bridge last measured it. */
    listen(): ListenHealth;
}

const DIRECT_FIX =
    'Postgres is probably behind a connection pooler in transaction mode (PgBouncer, RDS Proxy). ' +
    'Set API_PG_DB_DIRECT_HOST (or DATABASE_DIRECT_URL) to the Postgres server itself on api and worker, and restart them.';

/**
 * What a connection pooler in front of Postgres can break, checked from the
 * running API: the database settings Kodus reads, the lock table every
 * cross-instance job relies on, and LISTEN delivery between API and worker.
 */
export function databaseCheck(probe: DatabaseProbe): DoctorCheck {
    return {
        id: 'database',
        async run({ env }: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];

            let direct: ReturnType<typeof resolveDirectConnection>;
            try {
                resolveSessionTimeouts(env);
                direct = resolveDirectConnection(env);
            } catch (error) {
                results.push({
                    check: 'database.config',
                    status: 'fail',
                    title: 'A database setting is invalid.',
                    impact: 'The api and worker refuse to start with it.',
                    // Only our own messages, which name the variable and
                    // carry no credential; anything else stays in the log.
                    fix:
                        error instanceof DatabaseSettingError
                            ? error.message
                            : 'Check DATABASE_URL, DATABASE_DIRECT_URL, the API_PG_DB_* settings and DB_STATEMENT_TIMEOUT_MS / DB_IDLE_IN_TRANSACTION_TIMEOUT_MS on api and worker.',
                });
                return results;
            }

            try {
                await probe.locksReady();
                results.push({
                    check: 'database.locks',
                    status: 'ok',
                    title: 'Coordination locks are available.',
                });
            } catch (error) {
                results.push({
                    check: 'database.locks',
                    status: 'fail',
                    title: 'Kodus cannot take its coordination locks.',
                    impact: 'Reviews and scheduled jobs that need a lock fail or are skipped.',
                    fix: `Run the database migrations (RUN_MIGRATIONS=true on one api start). Error: ${String((error as Error)?.message ?? error).slice(0, 160)}`,
                });
            }

            const listen = probe.listen();
            const where = listen.connection ? ` (${listen.connection})` : '';
            switch (listen.status) {
                case 'delivering':
                    results.push({
                        check: 'database.listen',
                        status: 'ok',
                        title: `Live events between api and worker are delivered${where}.`,
                    });
                    break;
                case 'not-delivering':
                    results.push({
                        check: 'database.listen',
                        status: 'warn',
                        title: `Live events between api and worker do not arrive${where}.`,
                        impact: 'Review status in the UI and rule sync after a merge arrive up to 10 seconds late, through polling.',
                        fix: direct
                            ? `The direct connection ${describeConnection(direct)} does not deliver them either: point it at the Postgres server, not at the pooler.`
                            : DIRECT_FIX,
                    });
                    break;
                case 'pending':
                    results.push({
                        check: 'database.listen',
                        status: 'unknown',
                        title: 'Live event delivery has not been verified yet.',
                        fix: 'Run the doctor again in a few seconds; the api checks it right after connecting.',
                    });
                    break;
                default:
                    results.push({
                        check: 'database.listen',
                        status: 'unknown',
                        title: 'Could not verify live event delivery between api and worker.',
                        fix: 'Check the api logs for "CrossProcessEventsBridge" errors.',
                    });
            }

            return results;
        },
    };
}
