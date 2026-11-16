import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';

import { PgSql, type SqlQuery, type SqlQueryOptions } from '@libs/runtime/run/adapters/pg-sql';

/** Connections the API (or the product worker) holds on the Runtime Postgres, for every reader together. */
export const RUNTIME_READ_POOL_MAX = 10;

/**
 * The Runtime Postgres as the API (and the product worker) reads it: the
 * read-only URL (RUNTIME_DATABASE_READ_URL, role kodus_runtime_reader), every
 * query inside BEGIN READ ONLY (ADR-025). Never the owner's URL: the API has
 * no write access to the Runtime database.
 *
 * One pool for every reader of the Runtime database (the Run projection,
 * setups, lessons, cells, claims, egress, machine minutes, the Run stream and
 * the stop state): readers take this as their `SqlQuery` and never open a
 * pool of their own. Nest closes it once on shutdown (onModuleDestroy).
 *
 * Without the URL every read fails with 503 (ServiceUnavailableException),
 * whatever the reader: a reader never answers "empty" or "not stopped" for a
 * database it cannot see. A caller that can degrade (the Run cost leaves the
 * machine time unpriced, the egress settings fall back to their defaults)
 * catches the error itself.
 *
 * A broken idle connection (the Runtime database restarted) is logged and
 * dropped by pg; it never crashes the process, and the next read reconnects.
 */
export class RuntimeReadDb implements SqlQuery {
    private pool?: Pool;
    private readonly sql: PgSql;
    private readonly logger = new Logger(RuntimeReadDb.name);

    constructor(private readonly url: string | undefined) {
        this.sql = new PgSql(() => this.open(), { readOnly: true });
        if (!url) {
            this.logger.warn({ event: 'runtime.read_db.unconfigured', message: 'RUNTIME_DATABASE_READ_URL is not set: every Runtime read answers 503' });
        }
    }

    private open(): Pool {
        if (!this.url) throw new ServiceUnavailableException('Runtime database is not configured (RUNTIME_DATABASE_READ_URL, a read-only user)');
        if (!this.pool) {
            this.pool = new Pool({ connectionString: this.url, max: RUNTIME_READ_POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
            // pg drops a broken idle client before it emits: never log the error itself (it may carry connection details).
            this.pool.on('error', () => this.logger.warn({ event: 'runtime.read_db.unavailable', reason: 'idle_connection_error' }));
        }
        return this.pool;
    }

    query(text: string, values: unknown[], options?: SqlQueryOptions) {
        return this.sql.query(text, values, options);
    }

    async onModuleDestroy() {
        const pool = this.pool;
        this.pool = undefined;
        await pool?.end();
    }
}
