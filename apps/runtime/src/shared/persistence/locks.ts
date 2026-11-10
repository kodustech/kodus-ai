import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'crypto';

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

/** Two int4 keys from the lock name (pg_advisory_lock(int, int)). */
function keys(name: string): [number, number] {
    const h = createHash('sha256').update(`kody-runtime/lock\0${name}`).digest();
    return [h.readInt32BE(0), h.readInt32BE(4)];
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
        const [a, b] = keys(name);
        try {
            await client.query('SELECT pg_advisory_lock($1, $2)', [a, b]);
            try {
                return await this.inContext(client, fn);
            } finally {
                await client.query('SELECT pg_advisory_unlock($1, $2)', [a, b]);
            }
        } finally {
            client.release();
        }
    }

    async tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
        const client = await this.pool.connect();
        const [a, b] = keys(name);
        try {
            const got = (await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [a, b])).rows[0]?.ok === true;
            if (!got) return undefined;
            try {
                return await this.inContext(client, fn);
            } finally {
                await client.query('SELECT pg_advisory_unlock($1, $2)', [a, b]);
            }
        } finally {
            client.release();
        }
    }
}

/** One process: a promise chain per key (unit tests, the in-memory stack). */
export class InMemoryDistributedLocks implements DistributedLocks {
    private readonly chains = new Map<string, Promise<unknown>>();
    private readonly held = new Set<string>();

    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(async () => {
            this.held.add(key);
            try {
                return await fn();
            } finally {
                this.held.delete(key);
            }
        });
        this.chains.set(key, run.catch(() => undefined));
        return run;
    }

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
        if (this.held.has(key)) return undefined;
        return this.withLock(key, fn);
    }
}
