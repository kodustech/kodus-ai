import { Pool } from 'pg';

import { createLogger } from '@libs/core/log/logger';
import { decodeStreamOffset, type RunStreamEvent, type RunStreamPage, type RunStreamStore } from '@libs/runtime/run';
import { PgRunStreamStore, type SqlRunner } from '@libs/runtime/run/adapters/pg-run-stream.store';

/**
 * The Run stream as the API reads it (RUNTIME_STREAM_STORE=postgres, the
 * default): runtime.runtime_run_events in the Runtime Postgres, with the
 * read-only URL (RUNTIME_DATABASE_READ_URL, role kodus_runtime_reader: SELECT
 * on that table only) inside BEGIN READ ONLY (ADR-025). Every query names the
 * org and the Run, on the (org_id, run_id, seq) index.
 *
 * Cutover: with a `fallback` (RUNTIME_STREAM_DIR still set), a Run with no
 * row in Postgres is read from the file stream it was written to before the
 * switch, and a file offset keeps reading the file. Without the URL every
 * stream reads as not written yet.
 */
export class PgRuntimeRunStreamReader implements RunStreamStore {
    private pool?: Pool;
    private readonly logger = createLogger(PgRuntimeRunStreamReader.name);
    private readonly store: PgRunStreamStore;

    constructor(
        private readonly url: string | undefined,
        private readonly fallback?: Pick<RunStreamStore, 'read'>,
    ) {
        if (!url) {
            this.logger.warn({
                message: 'RUNTIME_DATABASE_READ_URL is not set: Run streams read as empty',
                context: PgRuntimeRunStreamReader.name,
            });
        }
        const readOnly: SqlRunner = { query: (text, values) => this.readOnly(text, values) };
        this.store = new PgRunStreamStore(readOnly);
    }

    private async readOnly(text: string, values: unknown[]) {
        this.pool ??= new Pool({ connectionString: this.url, max: 4, idleTimeoutMillis: 30_000 });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            const res = await client.query(text, values);
            await client.query('COMMIT');
            return res;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
    }

    /** The API never writes the Run stream: the hub does. */
    async append(_orgId: string, _runId: string, _event: RunStreamEvent): Promise<void> {
        throw new Error('the API does not write the Run stream');
    }

    async read(orgId: string, runId: string, offset?: string, maxEvents?: number): Promise<RunStreamPage | null> {
        const start = !offset || offset === '-1';
        if (!start && this.fallback && isFileOffset(offset)) return this.fallback.read(orgId, runId, offset, maxEvents);
        if (!this.url) return start && this.fallback ? this.fallback.read(orgId, runId, offset, maxEvents) : null;
        const page = await this.store.read(orgId, runId, offset, maxEvents);
        if (!page && start && this.fallback) return this.fallback.read(orgId, runId, offset, maxEvents);
        return page;
    }

    async onModuleDestroy() {
        await this.pool?.end();
    }
}

function isFileOffset(offset: string): boolean {
    try {
        decodeStreamOffset(offset);
        return true;
    } catch {
        return false;
    }
}
