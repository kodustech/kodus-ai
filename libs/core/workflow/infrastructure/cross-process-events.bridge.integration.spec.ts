/**
 * INTEGRATION TEST — CrossProcessEventsBridge with the app pool behind
 * PgBouncer in transaction mode (docker-compose.test.yml `db_pgbouncer`).
 *
 * LISTEN is accepted by a transaction-mode pooler and then never delivers:
 * the server session that ran it goes back to the pool. These specs pin what
 * an operator sees in that setup — the bridge says so — and that a direct
 * connection (API_PG_DB_DIRECT_* / DATABASE_DIRECT_URL) restores live
 * delivery between api and worker.
 *
 * Needs TEST_PGBOUNCER_PORT (CI sets it); refuses to run in CI without it.
 */
require('dotenv').config();

import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import {
    CrossProcessEventsBridge,
    ListenHealth,
} from './cross-process-events.bridge';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PGBOUNCER_PORT = process.env.TEST_PGBOUNCER_PORT
    ? parseInt(process.env.TEST_PGBOUNCER_PORT, 10)
    : undefined;
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';
if (!skipIntegration && process.env.CI && PGBOUNCER_PORT === undefined) {
    throw new Error(
        'TEST_PGBOUNCER_PORT is required in CI: this spec covers the PgBouncer setup.',
    );
}
const shouldRun = !skipIntegration && PGBOUNCER_PORT !== undefined;

const DIRECT_ENV = [
    'DATABASE_DIRECT_URL',
    'API_PG_DB_DIRECT_HOST',
    'API_PG_DB_DIRECT_PORT',
];

function makeDataSource(port: number): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        entities: [],
        extra: { max: 3 },
    });
}

async function settledListenHealth(timeoutMs = 20_000): Promise<ListenHealth> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const health = CrossProcessEventsBridge.listenStatus();
        if (health.status !== 'pending' || Date.now() > deadline) {
            return health;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

(shouldRun ? describe : describe.skip)(
    'CrossProcessEventsBridge behind PgBouncer in transaction mode (integration)',
    () => {
        let pooled: DataSource;
        let bridge: CrossProcessEventsBridge | undefined;
        const savedEnv: Record<string, string | undefined> = {};

        beforeAll(async () => {
            for (const key of DIRECT_ENV) savedEnv[key] = process.env[key];
            pooled = makeDataSource(PGBOUNCER_PORT!);
            await pooled.initialize();
        }, 30_000);

        afterEach(async () => {
            await bridge?.onModuleDestroy();
            bridge = undefined;
            CrossProcessEventsBridge.resetPrimaryForTests();
            for (const key of DIRECT_ENV) {
                if (savedEnv[key] === undefined) delete process.env[key];
                else process.env[key] = savedEnv[key];
            }
        });

        afterAll(async () => {
            await pooled?.destroy();
        });

        const startBridge = async (emitter = new EventEmitter2()) => {
            CrossProcessEventsBridge.resetPrimaryForTests();
            bridge = new CrossProcessEventsBridge(pooled, emitter);
            await bridge.onModuleInit();
            return { bridge, emitter };
        };

        it('without a direct connection, it reports that live events do not arrive', async () => {
            for (const key of DIRECT_ENV) delete process.env[key];

            await startBridge();

            expect(await settledListenHealth()).toMatchObject({
                status: 'not-delivering',
                connection: expect.stringContaining('(pooled)'),
            });
        }, 30_000);

        it('with a direct connection, an event another instance publishes arrives live', async () => {
            for (const key of DIRECT_ENV) delete process.env[key];
            process.env.DATABASE_DIRECT_URL = `postgres://${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASSWORD)}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

            const received = new Promise<unknown>((resolve) => {
                const emitter = new EventEmitter2();
                emitter.on('pull-request.closed', resolve);
                void startBridge(emitter);
            });
            expect(await settledListenHealth()).toMatchObject({
                status: 'delivering',
                connection: expect.stringContaining('(direct)'),
            });

            // Another api/worker instance publishes, through the pooler.
            const [row] = await pooled.query(
                `INSERT INTO kodus_cross_process_events (envelope)
                 VALUES ($1::jsonb) RETURNING id`,
                [
                    JSON.stringify({
                        instanceId: 'another-instance',
                        name: 'pull-request.closed',
                        payload: { pullRequestNumber: 7 },
                    }),
                ],
            );
            await pooled.query('SELECT pg_notify($1, $2)', [
                'kodus_cross_process_events',
                String(row.id),
            ]);

            // Well under the 10s polling fallback: this came through LISTEN.
            const payload = await Promise.race([
                received,
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error('not delivered in 3s')),
                        3_000,
                    ),
                ),
            ]);
            expect(payload).toMatchObject({ pullRequestNumber: 7 });
        }, 30_000);
    },
);
