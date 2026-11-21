import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';

import { PgSql, type SqlQuery, type SqlQueryOptions } from '@libs/runtime/run/adapters/pg-sql';

/** Connections the API (or the product worker) holds on the Runtime Postgres for the screens' reads. */
export const RUNTIME_READ_POOL_MAX = 10;
/**
 * Connections of the reports' own pool (Speed, the usage report): reads of
 * 10 to 15 s that, on the shared pool, held the connections the PR list,
 * the Run pages and the stream wait for (P5). At most this many reports run
 * at once per process; the next waits for one, never for a screen read.
 */
export const RUNTIME_REPORT_POOL_MAX = 3;
// The connection budget of the Runtime Postgres: each API and product-worker
// process opens up to RUNTIME_READ_POOL_MAX + RUNTIME_REPORT_POOL_MAX (13)
// read connections. Size the server's max_connections (and any pooler) for
// every process that holds RUNTIME_DATABASE_READ_URL, plus the
// runtime-worker's and the hub's own pools.

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
    private reportPool?: Pool;
    private readonly sql: PgSql;
    private readonly reportSql: PgSql;
    private readonly logger = new Logger(RuntimeReadDb.name);

    constructor(private readonly url: string | undefined) {
        this.sql = new PgSql(() => this.open('screens'), { readOnly: true });
        this.reportSql = new PgSql(() => this.open('reports'), { readOnly: true });
        if (!url) {
            this.logger.warn({ event: 'runtime.read_db.unconfigured', message: 'RUNTIME_DATABASE_READ_URL is not set: every Runtime read answers 503' });
        }
    }

    private open(kind: 'screens' | 'reports'): Pool {
        if (!this.url) throw new ServiceUnavailableException('Runtime database is not configured (RUNTIME_DATABASE_READ_URL, a read-only user)');
        const existing = kind === 'screens' ? this.pool : this.reportPool;
        if (existing) return existing;
        const pool = new Pool({
            connectionString: this.url,
            max: kind === 'screens' ? RUNTIME_READ_POOL_MAX : RUNTIME_REPORT_POOL_MAX,
            idleTimeoutMillis: 30_000,
            // A report waits longer for its turn than a screen read: only reports queue behind reports.
            connectionTimeoutMillis: kind === 'screens' ? 5_000 : 15_000,
        });
        // pg drops a broken idle client before it emits: never log the error itself (it may carry connection details).
        pool.on('error', () => this.logger.warn({ event: 'runtime.read_db.unavailable', reason: 'idle_connection_error', pool: kind }));
        if (kind === 'screens') this.pool = pool;
        else this.reportPool = pool;
        return pool;
    }

    query(text: string, values: unknown[], options?: SqlQueryOptions) {
        return this.sql.query(text, values, options);
    }

    /** The reports' pool (Speed, the usage report), apart from the screens' reads. */
    readonly reports: SqlQuery = {
        query: (text: string, values: unknown[], options?: SqlQueryOptions) => this.reportSql.query(text, values, options),
    };

    async onModuleDestroy() {
        const pools = [this.pool, this.reportPool];
        this.pool = undefined;
        this.reportPool = undefined;
        await Promise.all(pools.map((p) => p?.end()));
    }
}
