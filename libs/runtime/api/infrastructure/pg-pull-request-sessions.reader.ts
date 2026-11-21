import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PullRequestSessionsReader, StalePullRequest } from '../application/use-cases/pull-request-session-sweep.use-case';

/**
 * The PRs whose sessions are older than a time (runtime_snapshot_cells,
 * migration 31), read with kodus_runtime_reader (runtime-reader-grants.sql).
 */
export class PgPullRequestSessionsReader implements PullRequestSessionsReader {
    constructor(private readonly db: SqlQuery) {}

    async stalePullRequests(before: Date, limit: number): Promise<StalePullRequest[]> {
        const r = await this.db.query(
            `SELECT org_id, repository_id, pr_number, min(created_at) AS oldest FROM runtime.runtime_snapshot_cells
             WHERE pr_number IS NOT NULL AND snapshot_ref LIKE 'session:%' AND created_at < $1
             GROUP BY org_id, repository_id, pr_number ORDER BY oldest LIMIT $2`,
            [before, limit],
        );
        return (r.rows as Array<{ org_id: string; repository_id: string; pr_number: number }>).map((row) => ({ organizationId: row.org_id, repositoryId: row.repository_id, prNumber: Number(row.pr_number) }));
    }
}
