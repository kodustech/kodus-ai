import { AsyncLocalStorage } from 'node:async_hooks';
import { lockKey, lockStatement } from '@libs/runtime/run/adapters/advisory-lock';

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
        const client = await this.pool.connect();
        const key = lockKey('named', name);
        const unlock = lockStatement('pg_advisory_unlock', key);
        try {
            const lock = lockStatement('pg_advisory_lock', key);
            await client.query(lock.text, lock.values);
            try {
                return await this.inContext(client, fn);
            } finally {
                await client.query(unlock.text, unlock.values);
            }
        } finally {
            client.release();
        }
    }

    async tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
        const client = await this.pool.connect();
        const key = lockKey('named', name);
        const unlock = lockStatement('pg_advisory_unlock', key);
        try {
            const attempt = lockStatement('pg_try_advisory_lock', key);
            const got = (await client.query(attempt.text, attempt.values)).rows[0]?.acquired === true;
            if (!got) return undefined;
            try {
                return await this.inContext(client, fn);
            } finally {
                await client.query(unlock.text, unlock.values);
            }
        } finally {
            client.release();
        }
    }
}

