import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PendingSuiteBaseline, RuntimeSuiteBaselineReader } from '../domain/ports';

/**
 * The baseline suite runs the fleet asked for (runtime-fleet writes `runtime_suite_baseline_requests` when a template turns
 * ready): queued, and no suite run with the id the request carries yet. The read-only role cannot mark a request started;
 * the worker does when it starts the run, and a run row left by an earlier start also keeps the request out. Read-only,
 * through RuntimeReadDb.
 */
export class PgSuiteBaselineReader implements RuntimeSuiteBaselineReader {
    constructor(private readonly db: SqlQuery) {}

    async pending(limit: number): Promise<PendingSuiteBaseline[]> {
        const res = await this.db.query(
            `SELECT r.organization_id, r.environment_id, r.repository_id, r.main_sha, r.suite_run_id
               FROM runtime.runtime_suite_baseline_requests r
              WHERE r.state = 'queued'
                AND NOT EXISTS (SELECT 1 FROM runtime.runtime_suite_runs s WHERE s.suite_run_id = r.suite_run_id)
              ORDER BY r.requested_at, r.environment_id
              LIMIT $1`,
            [limit],
        );
        return (res.rows as Array<{ organization_id: string; environment_id: string; repository_id: string; main_sha: string; suite_run_id: string }>).map((x) => ({
            organizationId: x.organization_id,
            environmentId: x.environment_id,
            repositoryId: x.repository_id,
            mainSha: x.main_sha,
            suiteRunId: x.suite_run_id,
        }));
    }
}
