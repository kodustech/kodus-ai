import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { ExternalStopReader } from '../domain/external-findings';

/** The longest a stop read may run before the server cancels it: the admission fails closed instead of waiting. */
const STOP_READ_TIMEOUT_MS = 5_000;

/**
 * Stop state read from the Runtime database through the shared read-only
 * RuntimeReadDb. It never answers "not stopped" for a state it could not
 * read: without RUNTIME_DATABASE_READ_URL, or when the read fails, it throws
 * (503 when unconfigured) and the caller holds the work back.
 */
export class PgExternalStopReader implements ExternalStopReader {
    constructor(private readonly db: SqlQuery) {}

    async isStopped(organizationId: string): Promise<boolean> {
        const result = await this.db.query(
            `SELECT 1 FROM runtime.runtime_stops WHERE cleared_at IS NULL AND (scope='global' OR organization_id=$1) LIMIT 1`,
            [organizationId],
            { timeoutMs: STOP_READ_TIMEOUT_MS },
        );
        return result.rows.length > 0;
    }
}
