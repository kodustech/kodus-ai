import type { Pool, PoolConfig } from 'pg';

import { loadWorkerConfig, RUNTIME_PG_POOL } from '../shared/config';
import { PgDistributedLocks } from '../shared/persistence/locks';
import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { RUN_ENGINE_LOCKS } from './dbos/run-engine.service';
import { RUNTIME_LOCK_PG_POOL, RuntimeWorkerModule, runtimePgPoolOptions } from './runtime-worker.module';

/** A pg Pool with its max and connectionTimeoutMillis, and session advisory locks that block like Postgres (one lock table per test file). */
class FakePool {
    private inUse = 0;
    private readonly waiting: Array<() => void> = [];
    private static readonly held = new Map<string, Array<() => void> | null>();
    constructor(private readonly opts: PoolConfig) {}

    async connect() {
        if (this.inUse >= (this.opts.max ?? 10)) {
            await new Promise<void>((resolve, reject) => {
                const go = () => { clearTimeout(timer); resolve(); };
                this.waiting.push(go);
                const timer = this.opts.connectionTimeoutMillis
                    ? setTimeout(() => { this.waiting.splice(this.waiting.indexOf(go), 1); reject(new Error('timeout exceeded when trying to connect')); }, this.opts.connectionTimeoutMillis)
                    : undefined;
            });
        }
        this.inUse++;
        return {
            query: async (text: string, values: unknown[] = []) => {
                const key = JSON.stringify(values);
                if (text.includes('pg_advisory_lock(')) {
                    while (FakePool.held.has(key)) await new Promise<void>((r) => (FakePool.held.get(key) ?? []).push(r));
                    FakePool.held.set(key, []);
                } else if (text.includes('pg_advisory_unlock(')) {
                    const next = FakePool.held.get(key) ?? [];
                    FakePool.held.delete(key);
                    next.forEach((r) => r());
                }
                return { rows: [{ acquired: true }], rowCount: 1 };
            },
            release: () => {
                this.inUse--;
                this.waiting.shift()?.();
            },
        };
    }
}

/** n deliveries on one PR at once: each takes the PR lock, then reads through the store pool (as `requested` does). */
async function deliveries(locks: PgDistributedLocks, store: FakePool, n: number, pr: string) {
    const all = Array.from({ length: n }, () =>
        locks.withLock(pr, async () => {
            const c = await store.connect();
            try { await c.query('SELECT 1'); } finally { c.release(); }
        }),
    );
    let timer: NodeJS.Timeout | undefined;
    const hang = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 1_500)));
    try { return await Promise.race([Promise.all(all).then(() => 'done' as const), hang]); }
    finally { clearTimeout(timer); }
}

describe('runtime-worker Postgres pools', () => {
    const config = loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX });

    it('deadlocks when the lock holders share one pool with the reads they make inside the lock', async () => {
        const shared = new FakePool({ max: 4 });
        expect(await deliveries(new PgDistributedLocks(shared as unknown as Pool), shared, 5, 'pr:org/repo#1')).toBe('hung');
    });

    it('gives the locks a pool of their own, so every delivery the two lanes hold completes', async () => {
        const options = runtimePgPoolOptions(config);
        const pools = new Map<unknown, FakePool>([
            [RUNTIME_PG_POOL, new FakePool(options.store)],
            [RUNTIME_LOCK_PG_POOL, new FakePool(options.locks)],
        ]);
        const provider = (RuntimeWorkerModule.forConfig(config).providers as any[]).find((p) => p.provide === RUN_ENGINE_LOCKS);
        const locks: PgDistributedLocks = provider.useFactory(...provider.inject.map((t: unknown) => pools.get(t)));
        expect(await deliveries(locks, pools.get(RUNTIME_PG_POOL)!, 2 * config.brokerPrefetch + 5, 'pr:org/repo#2')).toBe('done');
    });

    it('sizes the lock pool to both lanes and always bounds the wait for a connection', () => {
        const options = runtimePgPoolOptions(config);
        expect(options.locks.max).toBeGreaterThan(2 * config.brokerPrefetch);
        expect(options.store.connectionTimeoutMillis).toBe(5000);
        expect(options.locks.connectionTimeoutMillis).toBe(5000);
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_BROKER_PREFETCH: '4', RUNTIME_PG_POOL_MAX: '20', RUNTIME_PG_CONNECTION_TIMEOUT_MS: '250' }))
            .toMatchObject({ brokerPrefetch: 4, pg: { poolMax: 20, lockPoolMax: 9, connectionTimeoutMs: 250 } });
        for (const env of [{ RUNTIME_BROKER_PREFETCH: '0' }, { RUNTIME_PG_POOL_MAX: '1' }, { RUNTIME_PG_CONNECTION_TIMEOUT_MS: '0' }]) {
            expect(() => loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, ...env })).toThrow();
        }
    });
});
