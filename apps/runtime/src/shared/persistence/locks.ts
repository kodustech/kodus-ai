import { AsyncLocalStorage } from 'node:async_hooks';
import { type LockKey, lockKey, lockStatement } from '@libs/runtime/run/adapters/advisory-lock';

import type { Pool, PoolClient } from 'pg';

// Cluster-wide mutual exclusion over the Runtime Postgres (session advisory
// locks on a dedicated connection). Used where replicas would otherwise race:
// the per-PR start/supersede decision of the consumer and the maintenance tick.

export interface DistributedLocks {
    /** Runs fn while holding the lock; waits for it. */
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
    /** Runs fn only if the lock is free right now; undefined when another holder has it. */
    tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export class PgDistributedLocks implements DistributedLocks {
    private readonly context = new AsyncLocalStorage<{ active: boolean; client: PoolClient }>();
    /** Only explicit store participants reuse this connection, while the lock is still held. */
    currentClient(): PoolClient | undefined {
        const context = this.context.getStore();
        return context?.active ? context.client : undefined;
    }
    private async inContext<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
        const context = { active: true, client };
        context.client = new Proxy(client, { get(target, key) {
            if (key === 'query') return (...args: unknown[]) => {
                if (!context.active) throw new Error('runtime_lock_context_expired');
                return Reflect.apply(target.query, target, args);
            };
            if (key === 'release') return () => { throw new Error('runtime_lock_client_owned_by_lock'); };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        try { return await this.context.run(context, fn); }
        finally { context.active = false; }
    }
    constructor(private readonly pool: Pool) {}

    async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const key = lockKey('named', name);
        return this.holding(key, async (client) => {
            const lock = lockStatement('pg_advisory_lock', key);
            await client.query(lock.text, lock.values);
            return true;
        }, fn) as Promise<T>;
    }

    async tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
        const key = lockKey('named', name);
        return this.holding(key, async (client) => {
            const attempt = lockStatement('pg_try_advisory_lock', key);
            return (await client.query(attempt.text, attempt.values)).rows[0]?.acquired === true;
        }, fn);
    }

    /**
     * Takes the lock on a connection of its own, runs fn, unlocks. A session lock lives as long as its
     * connection: one whose unlock did not go through (a broken connection, a transaction left aborted
     * by a failed ROLLBACK) is destroyed, never pooled still holding the lock. fn's own outcome wins.
     */
    private async holding<T>(key: LockKey, take: (client: PoolClient) => Promise<boolean>, fn: () => Promise<T>): Promise<T | undefined> {
        const client = await this.pool.connect();
        let broken: Error | undefined;
        try {
            let got: boolean;
            try {
                got = await take(client);
            } catch (e) {
                broken = e as Error;
                throw e;
            }
            if (!got) return undefined;
            try {
                return await this.inContext(client, fn);
            } finally {
                const unlock = lockStatement('pg_advisory_unlock', key);
                await client.query(unlock.text, unlock.values).catch((e: Error) => void (broken = e));
            }
        } finally {
            if (broken) client.release(broken);
            else client.release();
        }
    }
}

