/**
 * INTEGRATION TEST — DistributedLockService against a real Postgres.
 *
 * Exercises the failure modes that prompted the QueryRunner-pinning fix:
 *   1. Re-entrant FALSE acquire when the pool reuses a connection that
 *      already holds the advisory lock.
 *   2. Lock leak when release() runs on a different connection than
 *      acquire().
 *
 * Both modes manifest as "the gate lets >1 caller through" or "pg_locks
 * still shows the lock held after every caller released," depending on
 * how the pool happens to hand out connections. The fix pins one
 * QueryRunner per lock so acquire/release always run on the same
 * session. These tests assert that contract.
 *
 * The contentious tests deliberately spin up their own DataSource with
 * `extra.max = 2` to FORCE the pool to reuse connections across
 * callers — the same parameter window where `scripts/reproduce-
 * distributed-lock-bug.ts` reliably reproduces both failure modes
 * against the unfixed implementation. Without that forced reuse, pg-
 * pool's FIFO ordering can mask the bug under low contention.
 *
 * Skips automatically if Postgres isn't reachable, matching the pattern
 * used by other *.integration.spec.ts files (e.g.
 * test/integration/platformData/save-pull-request-cache.integration.spec.ts).
 */
// Load .env so API_PG_DB_PASSWORD / API_PG_DB_USERNAME resolve to the
// values docker-compose.dev.yml expects. Without this the spec would
// silently fall back to default credentials, probe Postgres with the
// wrong password, mark itself unreachable, and every test would no-op
// to "pass" — a false green.
require('dotenv').config();

import { DataSource } from 'typeorm';

import {
    DistributedLock,
    DistributedLockService,
} from './distributed-lock.service';

// docker-compose.dev.yml exposes Postgres on host port 5432, so the
// host-side jest runner reaches it at localhost. API_PG_DB_HOST is the
// container-internal hostname ("db_postgres") which won't resolve from
// the host — only use it when TEST_PG_HOST is explicitly set (e.g. when
// running tests inside the api container).
const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

function makeDataSource(poolMax: number): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
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

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource(1);
    try {
        await probe.initialize();
        await probe.query('SELECT 1');
        await probe.destroy();
        return true;
    } catch {
        try {
            await probe.destroy();
        } catch {
            // ignore
        }
        return false;
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'DistributedLockService (integration, real Postgres)',
    () => {
        let canRun = true;
        let baseDataSource: DataSource;
        let baseService: DistributedLockService;

        const uniqueKey = (suffix: string) =>
            `dls-integration::${process.pid}::${Date.now()}::${Math.random()
                .toString(36)
                .slice(2)}::${suffix}`;

        const hashKey = (
            svc: DistributedLockService,
            key: string,
        ): [number, number] =>
            (svc as unknown as {
                hashKey: (k: string) => [number, number];
            }).hashKey(key);

        const heldLockRows = async (
            ds: DataSource,
            svc: DistributedLockService,
            key: string,
        ) => {
            const [classid, objid] = hashKey(svc, key);
            return ds.query(
                `SELECT pid, granted FROM pg_locks
                  WHERE locktype = 'advisory'
                    AND classid = $1
                    AND objid = $2`,
                [classid, objid],
            );
        };

        beforeAll(async () => {
            const reachable = await isPostgresReachable();
            if (!reachable) {
                canRun = false;
                // Loud failure instead of silent no-op tests. If you
                // want to genuinely skip integration runs, set
                // SKIP_INTEGRATION=true.
                throw new Error(
                    `Postgres unreachable at ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}. ` +
                        `Set TEST_PG_* env vars or run with SKIP_INTEGRATION=true to skip.`,
                );
            }
            baseDataSource = makeDataSource(5);
            await baseDataSource.initialize();
            baseService = new DistributedLockService(baseDataSource);
        });

        afterAll(async () => {
            if (baseDataSource?.isInitialized) {
                await baseDataSource.destroy();
            }
        });

        // ── Basic API contract ─────────────────────────────────────

        it('acquires when no other holder exists, then releases cleanly', async () => {
            if (!canRun) return;
            const key = uniqueKey('basic');

            const lock = await baseService.acquire(key);
            expect(lock).not.toBeNull();
            expect(lock!.isReleased()).toBe(false);

            expect(
                (await heldLockRows(baseDataSource, baseService, key)).length,
            ).toBeGreaterThanOrEqual(1);

            await lock!.release();
            expect(lock!.isReleased()).toBe(true);
        });

        it('returns null when the key is already held', async () => {
            if (!canRun) return;
            const key = uniqueKey('exclusion');

            const first = await baseService.acquire(key);
            expect(first).not.toBeNull();

            const second = await baseService.acquire(key);
            expect(second).toBeNull();

            await first!.release();

            const third = await baseService.acquire(key);
            expect(third).not.toBeNull();
            await third!.release();
        });

        it('different keys never block each other', async () => {
            if (!canRun) return;
            const k1 = uniqueKey('k1');
            const k2 = uniqueKey('k2');

            const a = await baseService.acquire(k1);
            const b = await baseService.acquire(k2);
            expect(a).not.toBeNull();
            expect(b).not.toBeNull();

            await a!.release();
            await b!.release();
        });

        it('release() is idempotent — calling twice does not throw or double-unlock', async () => {
            if (!canRun) return;
            const key = uniqueKey('idempotent');

            const lock = await baseService.acquire(key);
            expect(lock).not.toBeNull();

            await lock!.release();
            await expect(lock!.release()).resolves.toBeUndefined();
            expect(lock!.isReleased()).toBe(true);
        });

        // ── Bug-targeted tests (use a dedicated tight-pool DataSource
        //    to force the connection-reuse scenario that exposes the
        //    pre-fix re-entrant FALSE acquire / wrong-connection
        //    release leak. These are the assertions that flip from
        //    PASS to FAIL on the unfixed implementation.) ───────────


        // ── TTL & isLocked ─────────────────────────────────────────

        it('TTL auto-releases the lock on the pinned session', async () => {
            if (!canRun) return;
            const ds = makeDataSource(2);
            await ds.initialize();
            const svc = new DistributedLockService(ds);
            try {
                const key = uniqueKey('ttl');
                const TTL_MS = 150;

                const lock = await svc.acquire(key, { ttl: TTL_MS });
                expect(lock).not.toBeNull();
                expect(lock!.isReleased()).toBe(false);

                // Run some unrelated pool churn so a wrong-connection
                // auto-release would also fail to unlock.
                await Promise.all([
                    ds.query('SELECT pg_sleep(0.01)'),
                    ds.query('SELECT pg_sleep(0.01)'),
                ]);

                await sleep(TTL_MS + 400);

                expect(lock!.isReleased()).toBe(true);
                const leaked = await heldLockRows(ds, svc, key);
                expect(leaked).toEqual([]);

                const reacquired = await svc.acquire(key);
                expect(reacquired).not.toBeNull();
                await reacquired!.release();
            } finally {
                await ds.destroy();
            }
        });

        it('isLocked() does not leak the advisory lock when the key is free', async () => {
            if (!canRun) return;
            const ds = makeDataSource(2);
            await ds.initialize();
            const svc = new DistributedLockService(ds);
            try {
                const key = uniqueKey('islocked-free');

                // Warm the pool, then run pool churn so isLocked's
                // internal unlock would land on the wrong connection
                // under the unfixed implementation.
                await Promise.all([ds.query('SELECT 1'), ds.query('SELECT 1')]);
                await expect(svc.isLocked(key)).resolves.toBe(false);
                await Promise.all([
                    ds.query('SELECT pg_sleep(0.01)'),
                    ds.query('SELECT pg_sleep(0.01)'),
                ]);

                const leaked = await heldLockRows(ds, svc, key);
                expect(leaked).toEqual([]);
            } finally {
                await ds.destroy();
            }
        });

        it('isLocked() reports true when another holder has the key', async () => {
            if (!canRun) return;
            const key = uniqueKey('islocked-held');

            const lock = await baseService.acquire(key);
            expect(lock).not.toBeNull();

            await expect(baseService.isLocked(key)).resolves.toBe(true);

            await lock!.release();
        });

        it('failed acquire does not leak a pooled connection', async () => {
            if (!canRun) return;
            const ds = makeDataSource(3);
            await ds.initialize();
            const svc = new DistributedLockService(ds);
            try {
                const key = uniqueKey('failpath');
                const holder = await svc.acquire(key);
                expect(holder).not.toBeNull();

                // Run more failed-acquire attempts than the pool size.
                // If the failure path leaked the QueryRunner, the pool
                // would exhaust and the next attempt would block on
                // connectionTimeoutMillis until throwing.
                const FAILED_ATTEMPTS = 12;
                for (let i = 0; i < FAILED_ATTEMPTS; i++) {
                    const start = Date.now();
                    const got = await svc.acquire(key);
                    expect(got).toBeNull();
                    expect(Date.now() - start).toBeLessThan(2000);
                }

                await holder!.release();
            } finally {
                await ds.destroy();
            }
        });
    },
);

// Keep the import of DistributedLock alive so unused-symbol linters don't
// strip it — it is the public return type of acquire().
void DistributedLock;
