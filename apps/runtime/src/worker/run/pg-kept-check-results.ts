import type { Pool } from 'pg';

import type { KeptCheckResultRow, KeptCheckResults } from './ports';

/**
 * runtime.runtime_kept_check_results (docs/runtime/kept-checks.md §4): one row
 * per Run and kept check, scoped by org, environment and repository; ids, an
 * outcome and a reason code only. The API reads it with the read-only role for
 * the list of kept checks and the metric. Retention removes rows older than
 * KEPT_CHECK_RESULTS_RETENTION_DAYS (applyRetention).
 */
export class PgKeptCheckResults implements KeptCheckResults {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async record(scope: { orgId: string; environmentId: string; repositoryId: string; runId: string; prNumber: number }, rows: KeptCheckResultRow[]): Promise<void> {
        if (rows.length === 0) return;
        // One statement, idempotent per (org, Run, kept check): a retried step writes nothing twice.
        await this.pool.query(
            `INSERT INTO runtime.runtime_kept_check_results
                (org_id, environment_id, repository_id, run_id, pr_number, kept_check_id, source_pr_number, outcome, stale_reason)
             SELECT $1, $2, $3, $4, $5, r.kept_check_id, r.source_pr_number, r.outcome, r.stale_reason
             FROM jsonb_to_recordset($6::jsonb) AS r(kept_check_id text, source_pr_number int, outcome text, stale_reason text)
             ON CONFLICT (org_id, run_id, kept_check_id) DO NOTHING`,
            [
                scope.orgId,
                scope.environmentId,
                scope.repositoryId,
                scope.runId,
                scope.prNumber,
                JSON.stringify(rows.map((r) => ({ kept_check_id: r.keptCheckId, source_pr_number: r.sourcePrNumber, outcome: r.outcome, stale_reason: r.staleReason ?? null }))),
            ],
        );
    }
}
