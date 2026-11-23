/**
 * INTEGRATION TEST — DistributedLockService against a real Postgres, and
 * against the same Postgres behind PgBouncer in transaction mode.
 *
 * Each "instance" is its own DataSource + service, the way two api/worker
 * replicas are. Behind PgBouncer the session advisory locks this service
 * used before let both instances hold one key and left released keys held;
 * the same specs on both targets prove the lease implementation does not
 * depend on keeping a server session.
 *
 * Targets: Postgres at TEST_PG_HOST:TEST_PG_PORT (default localhost:5432),
 * and PgBouncer at TEST_PG_HOST:TEST_PGBOUNCER_PORT when set. CI sets it
 * (docker-compose.test.yml `db_pgbouncer`), and the spec refuses to run in
 * CI without it so the pooler case can never be skipped silently.
 */
// Load .env so API_PG_DB_PASSWORD / API_PG_DB_USERNAME resolve to the
// values docker-compose.dev.yml expects. Without this the spec would
// silently fall back to default credentials and fail to connect.
require('dotenv').config();

import { fork } from 'node:child_process';
import { createServer, connect, Server, Socket } from 'node:net';
import { resolve } from 'node:path';

import { DataSource } from 'typeorm';

import { DistributedLockLeases2026112300000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026112300000000-DistributedLockLeases';

import { DistributedLockService } from './distributed-lock.service';
import { ThreadLeaseRenewer } from './lease-renewer';
import { DistributedLockRepository } from './repositories/distributed-lock.repository';

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
        'TEST_PGBOUNCER_PORT is required in CI: the PgBouncer case is what this spec exists for.',
    );
}

function makeDataSource(port: number, poolMax = 5): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        synchronize: false,
        entities: [],
        extra: {
            max: poolMax,
            min: 1,
            idleTimeoutMillis: 60_000,
            connectionTimeoutMillis: 10_000,
            keepAlive: true,
        },
    });
}

const uniqueKey = (suffix: string) =>
    `dls-it::${process.pid}::${Date.now()}::${Math.random()
        .toString(36)
        .slice(2)}::${suffix}`;

const targets = [
    { name: 'Postgres, direct', port: PG_PORT },
    ...(PGBOUNCER_PORT !== undefined
        ? [{ name: 'PgBouncer, transaction mode', port: PGBOUNCER_PORT }]
        : []),
];

(skipIntegration ? describe.skip : describe)(
    'DistributedLockService (integration)',
    () => {
        beforeAll(async () => {
            // The lease table comes from a migration; run its up() (idempotent)
            // so the spec does not depend on the migration runner.
            const direct = makeDataSource(PG_PORT, 1);
            try {
                await direct.initialize();
            } catch (error) {
                throw new Error(
                    `Postgres unreachable at ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB} (${(error as Error).message}). ` +
                        'Set TEST_PG_* env vars or run with SKIP_INTEGRATION=true to skip.',
                    { cause: error },
                );
            }
            const runner = direct.createQueryRunner();
            await new DistributedLockLeases2026112300000000().up(runner);
            await runner.release();
            await direct.destroy();
        }, 30_000);

        describe.each(targets)('on $name', ({ port }) => {
            const sources: DataSource[] = [];
            let instanceA: DistributedLockService;
            let instanceB: DistributedLockService;
            let observer: DistributedLockService;
            let repository: DistributedLockRepository;

            beforeAll(async () => {
                // Small pools, so the pooler keeps reusing the same few
                // server sessions — the condition that broke session locks.
                for (let i = 0; i < 3; i++) {
                    const ds = makeDataSource(port, 2);
                    await ds.initialize();
                    sources.push(ds);
                }
                instanceA = new DistributedLockService(sources[0]);
                instanceB = new DistributedLockService(sources[1]);
                observer = new DistributedLockService(sources[2]);
                repository = new DistributedLockRepository(sources[2]);
            }, 30_000);

            afterAll(async () => {
                await ThreadLeaseRenewer.stopAll();
                await Promise.all(sources.map((ds) => ds.destroy()));
            });

            it('two instances never hold the same key at the same time, and a released key is free right away', async () => {
                for (let round = 0; round < 20; round++) {
                    const key = uniqueKey(`exclusive-${round}`);

                    const lockA = await instanceA.acquire(key);
                    expect(lockA).not.toBeNull();
                    expect(await instanceB.acquire(key)).toBeNull();

                    await lockA!.release();
                    expect(await observer.isLocked(key)).toBe(false);

                    const lockB = await instanceB.acquire(key);
                    expect(lockB).not.toBeNull();
                    await lockB!.release();
                }
            });

            it('many instances racing for one key: exactly one wins', async () => {
                const key = uniqueKey('race');
                const contenders = [
                    instanceA,
                    instanceB,
                    observer,
                    instanceA,
                    instanceB,
                    observer,
                ];
                const results = await Promise.all(
                    contenders.map((svc) => svc.acquire(key)),
                );
                const winners = results.filter((lock) => lock !== null);
                expect(winners).toHaveLength(1);
                await winners[0]!.release();
            });

            /**
             * Moves a lease past its expiry (or max hold) on the database
             * clock, instead of sleeping: the specs then hold on any
             * latency, including a busy CI runner.
             */
            const expireLease = (key: string) =>
                sources[2].query(
                    `UPDATE "kodus_workflow"."distributed_locks"
                        SET expires_at = now() - interval '1 second'
                      WHERE lock_key = $1`,
                    [key],
                );
            const reachMaxHold = (key: string) =>
                sources[2].query(
                    `UPDATE "kodus_workflow"."distributed_locks"
                        SET max_hold_until = now() - interval '1 second'
                      WHERE lock_key = $1`,
                    [key],
                );

            it('a holder that died frees the key once its lease expires', async () => {
                const key = uniqueKey('dead-holder');
                expect(await repository.tryAcquire(key, 'dead', 60_000)).toBe(
                    true,
                );
                expect(await repository.tryAcquire(key, 'alive', 60_000)).toBe(
                    false,
                );

                await expireLease(key);

                expect(await repository.tryAcquire(key, 'alive', 60_000)).toBe(
                    true,
                );
                await repository.release(key, 'alive');
            });

            it('renewing keeps a lease alive, but never past its max hold', async () => {
                const key = uniqueKey('max-hold');
                expect(
                    await repository.tryAcquire(key, 'holder', 60_000, 120_000),
                ).toBe(true);

                // A beat that lands after the lease ran out, before anyone
                // took the key, keeps it.
                await expireLease(key);
                expect(await repository.renew(key, 'holder', 60_000)).toBe(
                    true,
                );
                expect(await repository.isHeld(key)).toBe(true);

                await reachMaxHold(key);
                expect(await repository.renew(key, 'holder', 60_000)).toBe(
                    false,
                );
                expect(await repository.isHeld(key)).toBe(false);
                expect(await repository.tryAcquire(key, 'next', 60_000)).toBe(
                    true,
                );
                await repository.release(key, 'next');
            });

            it('a holder whose lease was taken over can neither renew nor release the new holder', async () => {
                const key = uniqueKey('takeover');
                expect(await repository.tryAcquire(key, 'old', 60_000)).toBe(
                    true,
                );
                await expireLease(key);
                expect(await repository.tryAcquire(key, 'new', 60_000)).toBe(
                    true,
                );

                expect(await repository.renew(key, 'old', 60_000)).toBe(false);
                expect(await repository.release(key, 'old')).toBe(false);
                expect(await repository.isHeld(key)).toBe(true);

                await repository.release(key, 'new');
            });

            /**
             * Runs a lock holder in a child process and blocks its event
             * loop, the way a CPU-bound review step blocks a worker, while
             * this process — another replica — tries to take the key.
             */
            const runBlockedHolder = async (
                key: string,
                leaseMs: number,
                blockMs: number,
                duringBlock: () => Promise<void>,
            ): Promise<{ lost: boolean | null }> => {
                const child = fork(
                    resolve(
                        __dirname,
                        '__tests__/blocked-lock-holder.fixture.ts',
                    ),
                    [],
                    {
                        execArgv: [
                            '-r',
                            'ts-node/register/transpile-only',
                            '-r',
                            'tsconfig-paths/register',
                        ],
                        env: {
                            ...process.env,
                            LOCK_IT_HOST: PG_HOST,
                            LOCK_IT_PORT: String(port),
                            LOCK_IT_USER: PG_USER,
                            LOCK_IT_PASSWORD: PG_PASSWORD,
                            LOCK_IT_DB: PG_DB,
                        },
                    },
                );
                const messages: any[] = [];
                const next = () =>
                    new Promise<any>((done, fail) => {
                        if (messages.length) return done(messages.shift());
                        child.once('message', () => done(messages.shift()));
                        child.once('exit', (code) =>
                            fail(new Error(`holder exited ${code}`)),
                        );
                    });
                child.on('message', (m) => messages.push(m));
                try {
                    child.send({ key, leaseMs, blockMs });
                    const first = await next();
                    if (first.error) throw new Error(first.error);
                    expect(first.acquired).toBe(true);
                    await duringBlock();
                    const second = await next();
                    if (second.error) throw new Error(second.error);
                    return second;
                } finally {
                    if (child.exitCode === null) {
                        await new Promise((done) => {
                            child.once('exit', done);
                            setTimeout(() => child.kill(), 15_000).unref();
                        });
                    }
                }
            };

            it('a holder whose event loop is blocked longer than its lease keeps the lock', async () => {
                const key = uniqueKey('blocked-loop');
                const leaseMs = 2_000;
                let takenWhileBlocked: unknown = 'not tried';

                const result = await runBlockedHolder(
                    key,
                    leaseMs,
                    8_000,
                    async () => {
                        // Well past the lease, while the holder is still blocked.
                        await new Promise((r) => setTimeout(r, leaseMs * 2));
                        const lock = await instanceB.acquire(key);
                        takenWhileBlocked = lock !== null;
                        await lock?.release();
                    },
                );

                expect(takenWhileBlocked).toBe(false);
                expect(result.lost).toBe(false);
            }, 60_000);

            it('if the renewal thread dies, a new one takes over the held leases', async () => {
                const key = uniqueKey('thread-restart');
                const leaseMs = 2_000;
                const holder = new DistributedLockService(
                    sources[0],
                    undefined,
                    { leaseMs },
                );
                const lock = await holder.acquire(key);
                expect(lock).not.toBeNull();

                const renewer = (holder as any).renewer;
                await renewer.worker.terminate();
                await new Promise((r) => setTimeout(r, leaseMs * 2));

                expect(await instanceB.acquire(key)).toBeNull();
                expect(lock!.isLost()).toBe(false);
                await lock!.release();
            }, 20_000);

            /**
             * A TCP relay to the target that can freeze the connections it
             * already carries: they stay open but nothing moves, the way a
             * connection looks after a pooler restart or a dropped route.
             * Connections opened after the freeze relay normally.
             */
            const startRelay = async () => {
                const pairs: [Socket, Socket][] = [];
                const all: Socket[] = [];
                const server: Server = createServer((client) => {
                    const upstream = connect(port, PG_HOST);
                    client.pipe(upstream);
                    upstream.pipe(client);
                    const drop = () => {
                        client.destroy();
                        upstream.destroy();
                    };
                    client.on('error', drop);
                    upstream.on('error', drop);
                    pairs.push([client, upstream]);
                    all.push(client, upstream);
                });
                await new Promise<void>((done) =>
                    server.listen(0, '127.0.0.1', () => done()),
                );
                return {
                    port: (server.address() as any).port as number,
                    freezeExisting: () => {
                        for (const [client, upstream] of pairs.splice(0)) {
                            client.unpipe(upstream);
                            upstream.unpipe(client);
                            client.pause();
                            upstream.pause();
                        }
                    },
                    close: async () => {
                        for (const socket of all) socket.destroy();
                        await new Promise((done) => server.close(done));
                    },
                };
            };

            it('a renewal connection that hangs without an error is replaced, and the lock is kept', async () => {
                const key = uniqueKey('hung-renewal');
                const leaseMs = 2_000;
                const relay = await startRelay();
                const viaRelay = new DataSource({
                    type: 'postgres',
                    host: '127.0.0.1',
                    port: relay.port,
                    username: PG_USER,
                    password: PG_PASSWORD,
                    database: PG_DB,
                    entities: [],
                    extra: { max: 1 },
                });
                await viaRelay.initialize();
                const holder = new DistributedLockService(viaRelay, undefined, {
                    leaseMs,
                });
                try {
                    const lock = await holder.acquire(key);
                    expect(lock).not.toBeNull();
                    // Let the renewal thread open its connection, then freeze it.
                    await new Promise((r) => setTimeout(r, leaseMs));
                    relay.freezeExisting();
                    await new Promise((r) => setTimeout(r, leaseMs * 2.5));

                    expect(await instanceB.acquire(key)).toBeNull();
                    expect(lock!.isLost()).toBe(false);
                } finally {
                    await ThreadLeaseRenewer.stopAll();
                    await relay.close();
                    await viaRelay.destroy().catch(() => undefined);
                    await sources[2].query(
                        `DELETE FROM "kodus_workflow"."distributed_locks" WHERE lock_key = $1`,
                        [key],
                    );
                }
            }, 30_000);

            it('a renewal connection the server terminates is reopened, and the lock is kept', async () => {
                const key = uniqueKey('terminated-renewal');
                const leaseMs = 2_000;
                const holder = new DistributedLockService(
                    sources[0],
                    undefined,
                    { leaseMs },
                );
                const lock = await holder.acquire(key);
                expect(lock).not.toBeNull();
                await new Promise((r) => setTimeout(r, leaseMs));

                // Always on PostgreSQL itself: through PgBouncer this ends
                // the server side of whatever client the pooler maps.
                const admin = makeDataSource(PG_PORT, 1);
                await admin.initialize();
                await admin.query(
                    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                      WHERE application_name = 'kodus-lock-renewer'`,
                );
                await admin.destroy();
                await new Promise((r) => setTimeout(r, leaseMs * 2));

                expect(await instanceB.acquire(key)).toBeNull();
                expect(lock!.isLost()).toBe(false);
                await lock!.release();
            }, 30_000);

            it('renews about every third of its lease, not continuously', async () => {
                const key = uniqueKey('cadence');
                const leaseMs = 3_000;
                const holder = new DistributedLockService(
                    sources[0],
                    undefined,
                    { leaseMs },
                );
                const lock = await holder.acquire(key);
                expect(lock).not.toBeNull();

                // Every renewal writes a new row version; count them over
                // three leases' worth of thirds.
                const versions = new Set<string>();
                const until = Date.now() + leaseMs;
                while (Date.now() < until) {
                    const [row] = await sources[2].query(
                        `SELECT ctid::text AS v FROM "kodus_workflow"."distributed_locks" WHERE lock_key = $1`,
                        [key],
                    );
                    versions.add(row.v);
                    await new Promise((r) => setTimeout(r, 50));
                }
                await lock!.release();

                // The acquired version plus about three renewals; a renewer
                // that ran on every 250ms tick would write about twelve.
                expect(versions.size).toBeGreaterThanOrEqual(2);
                expect(versions.size).toBeLessThanOrEqual(6);
            }, 20_000);

            it('a holder whose lease was taken over learns it from the next renewal', async () => {
                const key = uniqueKey('lost');
                const holder = new DistributedLockService(
                    sources[0],
                    undefined,
                    { leaseMs: 2_000 },
                );
                const lock = await holder.acquire(key);
                await expireLease(key);
                const taken = await instanceB.acquire(key);
                expect(taken).not.toBeNull();

                await new Promise((r) => setTimeout(r, 1_500));

                expect(lock!.isLost()).toBe(true);
                await taken!.release();
                await holder.onModuleDestroy();
            }, 20_000);

            it('the sweep deletes leases left by dead holders and keeps live ones', async () => {
                const dead = uniqueKey('sweep-dead');
                const live = uniqueKey('sweep-live');
                await repository.tryAcquire(dead, 'dead', 60_000);
                await repository.tryAcquire(live, 'live', 60_000);
                // Expired long ago, past the sweep's grace. Other specs'
                // freshly expired rows stay untouched by this sweep.
                await sources[2].query(
                    `UPDATE "kodus_workflow"."distributed_locks"
                        SET expires_at = now() - interval '2 hours'
                      WHERE lock_key = $1`,
                    [dead],
                );

                expect(
                    await repository.deleteExpired(60 * 60 * 1000),
                ).toBeGreaterThanOrEqual(1);

                expect(await repository.isHeld(dead)).toBe(false);
                expect(await repository.tryAcquire(live, 'other', 60_000)).toBe(
                    false,
                );
                await repository.release(live, 'live');
            });
        });
    },
);
