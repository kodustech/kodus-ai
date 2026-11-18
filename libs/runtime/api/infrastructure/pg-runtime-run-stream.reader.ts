import { decodeStreamOffset, type RunStreamEvent, type RunStreamPage, type RunStreamStore } from '@libs/runtime/run';
import { PgRunStreamStore } from '@libs/runtime/run/adapters/pg-run-stream.store';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

/**
 * The Run stream as the API reads it (RUNTIME_STREAM_STORE=postgres, the
 * default): runtime.runtime_run_events in the Runtime Postgres, through the
 * shared read-only RuntimeReadDb (RUNTIME_DATABASE_READ_URL, role
 * kodus_runtime_reader: SELECT on that table only, ADR-025). Every query
 * names the org and the Run, on the (org_id, run_id, seq) index. Without the
 * URL a read fails with 503, as every Runtime read does.
 *
 * Cutover: with a `fallback` (RUNTIME_STREAM_DIR still set), a Run with no
 * row in Postgres is read from the file stream it was written to before the
 * switch, and a file offset keeps reading the file.
 */
export class PgRuntimeRunStreamReader implements RunStreamStore {
    private readonly store: PgRunStreamStore;

    constructor(
        db: SqlQuery,
        private readonly fallback?: Pick<RunStreamStore, 'read'>,
    ) {
        this.store = new PgRunStreamStore(db);
    }

    /** The API never writes the Run stream: the hub does. */
    async append(_orgId: string, _runId: string, _event: RunStreamEvent): Promise<void> {
        throw new Error('the API does not write the Run stream');
    }

    async read(orgId: string, runId: string, offset?: string, maxEvents?: number): Promise<RunStreamPage | null> {
        const start = !offset || offset === '-1';
        if (!start && this.fallback && isFileOffset(offset)) return this.fallback.read(orgId, runId, offset, maxEvents);
        const page = await this.store.read(orgId, runId, offset, maxEvents);
        if (!page && start && this.fallback) return this.fallback.read(orgId, runId, offset, maxEvents);
        return page;
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
