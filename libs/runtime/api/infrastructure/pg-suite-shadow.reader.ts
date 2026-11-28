import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PendingSuiteShadow, RuntimeSuiteShadowReader } from '../domain/ports';

/**
 * The shadows of selected PR runs the worker recorded (`runtime_suite_shadows`): queued, and no suite run with the id the row carries
 * yet. The read-only role cannot mark one started; the worker does when it starts the run. Read-only, through RuntimeReadDb.
 */
export class PgSuiteShadowReader implements RuntimeSuiteShadowReader {
    constructor(private readonly db: SqlQuery) {}

    async pending(limit: number): Promise<PendingSuiteShadow[]> {
        const res = await this.db.query(
            `SELECT h.shadow_run_id, h.organization_id, h.environment_id, h.repository_id, h.pr_number, h.pr_sha, h.merge_base, h.main_sha, h.changed_files, h.removed_files
               FROM runtime.runtime_suite_shadows h
              WHERE h.state = 'queued'
                AND NOT EXISTS (SELECT 1 FROM runtime.runtime_suite_runs s WHERE s.suite_run_id = h.shadow_run_id)
              ORDER BY h.requested_at, h.shadow_run_id
              LIMIT $1`,
            [limit],
        );
        return (res.rows as Array<Record<string, any>>).map((x) => ({
            organizationId: x.organization_id,
            environmentId: x.environment_id,
            repositoryId: x.repository_id,
            shadowRunId: x.shadow_run_id,
            prNumber: x.pr_number,
            prSha: x.pr_sha,
            mergeBase: x.merge_base,
            mainSha: x.main_sha,
            changedFiles: x.changed_files,
            removedFiles: x.removed_files,
        }));
    }
}
