import type { Pool, PoolClient } from 'pg';
import type { PgDistributedLocks } from './locks';

export const LOCK_SCOPED_PG = Symbol('LOCK_SCOPED_PG');
/** Explicit participant in a PR lock: reuses its live client, never borrows a second pool slot. */
export class LockScopedPg {
    private readonly transactions = new WeakSet<PoolClient>();
    constructor(
        private readonly pool: Pool,
        private readonly locks?: Pick<PgDistributedLocks, 'currentClient'>,
    ) {}
    readonly query: Pool['query'] = ((...args: unknown[]) => {
        const db = this.locks?.currentClient() ?? this.pool;
        if (this.transactions.has(db as PoolClient))
            throw new Error('runtime_transaction_in_progress');
        return Reflect.apply(db.query, db, args);
    }) as Pool['query'];

    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const held = this.locks?.currentClient();
        const client = held ?? (await this.pool.connect());
        if (this.transactions.has(client))
            throw new Error('runtime_nested_transaction');
        this.transactions.add(client);
        try {
            await client.query('BEGIN');
            try {
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw error;
            }
        } finally {
            this.transactions.delete(client);
            if (!held) client.release();
        }
    }
}
