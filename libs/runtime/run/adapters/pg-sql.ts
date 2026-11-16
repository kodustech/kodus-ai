import { inTransaction } from './advisory-lock';
import type { Pool, PoolClient, QueryResult } from 'pg';

/** One bounded query: the server cancels it past `timeoutMs`; a caller that gave up (`signal`) never starts it. */
export interface SqlQueryOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** The SQL the Runtime's Postgres stores run: a pool, or a read-only transaction around one. */
export interface SqlQuery {
    query(text: string, values: unknown[], options?: SqlQueryOptions): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * A pg Pool as a SqlQuery. `readOnly` runs every query inside BEGIN READ ONLY
 * (the API's reads of the Runtime database, ADR-025: a write is refused by
 * the server even before the role's grants are checked). A timeout sets a
 * server-side statement_timeout for that query only.
 */
export class PgSql implements SqlQuery {
    constructor(
        private readonly pool: () => Pick<Pool, 'connect' | 'query'>,
        private readonly opts: { readOnly?: boolean } = {},
    ) {}

    async query(text: string, values: unknown[], options: SqlQueryOptions = {}): Promise<QueryResult> {
        options.signal?.throwIfAborted();
        if (!this.opts.readOnly && !options.timeoutMs) return this.pool().query(text, values);
        const client: PoolClient = await this.pool().connect();
        if (options.signal?.aborted) {
            // The caller gave up while it waited for a connection: its query never starts.
            client.release();
            options.signal.throwIfAborted();
        }
        let broken = false;
        try {
            return await inTransaction(
                client,
                async () => {
                    if (options.timeoutMs) await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`);
                    return client.query(text, values);
                },
                { readOnly: this.opts.readOnly, onRollbackFailed: () => (broken = true) },
            );
        } finally {
            // A connection whose ROLLBACK failed may still be in the transaction: it is destroyed, never pooled.
            client.release(broken || undefined);
        }
    }
}
