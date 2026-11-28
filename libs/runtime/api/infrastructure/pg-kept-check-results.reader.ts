import type { KeptCheckOutcomeKind, KeptCheckStaleReason } from '@libs/runtime/contracts/kept-check';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { KeptCheckResultsReader, KeptCheckResultSummary } from '../domain/ports';

/** The longest a kept-check read may run before the server cancels it. */
const READ_TIMEOUT_MS = 5_000;

/**
 * runtime.runtime_kept_check_results (runtime-schema v37), written by the
 * runtime-worker, read through the shared read-only RuntimeReadDb. Every query
 * filters on the org. Without RUNTIME_DATABASE_READ_URL a read throws (503):
 * it never answers "no outcome" for a database it cannot see.
 */
export class PgKeptCheckResultsReader implements KeptCheckResultsReader {
    constructor(private readonly db: SqlQuery) {}

    async summaries(organizationId: string, keptCheckIds: string[]): Promise<KeptCheckResultSummary[]> {
        if (keptCheckIds.length === 0) return [];
        const { rows } = await this.db.query(
            `SELECT k.kept_check_id, l.outcome, l.stale_reason, l.run_id, l.pr_number, l.recorded_at,
                    (SELECT count(DISTINCT (f.repository_id, f.pr_number)) FROM runtime.runtime_kept_check_results f
                      WHERE f.org_id = $1 AND f.kept_check_id = k.kept_check_id AND f.outcome = 'failed' AND f.pr_number <> f.source_pr_number) AS failures
             FROM unnest($2::text[]) AS k(kept_check_id)
             LEFT JOIN LATERAL (
                SELECT outcome, stale_reason, run_id, pr_number, recorded_at FROM runtime.runtime_kept_check_results r
                WHERE r.org_id = $1 AND r.kept_check_id = k.kept_check_id
                ORDER BY recorded_at DESC, run_id DESC LIMIT 1
             ) l ON true`,
            [organizationId, keptCheckIds],
            { timeoutMs: READ_TIMEOUT_MS },
        );
        return (rows as Array<{ kept_check_id: string; outcome: KeptCheckOutcomeKind | null; stale_reason: KeptCheckStaleReason | null; run_id: string | null; pr_number: number | null; recorded_at: Date | string | null; failures: string | number }>).map((r) => ({
            keptCheckId: r.kept_check_id,
            ...(r.outcome && r.run_id && r.pr_number !== null && r.recorded_at
                ? {
                      last: {
                          outcome: r.outcome,
                          ...(r.stale_reason ? { staleReason: r.stale_reason } : {}),
                          runId: r.run_id,
                          prNumber: Number(r.pr_number),
                          at: new Date(r.recorded_at).toISOString(),
                      },
                  }
                : {}),
            failuresOnLaterPrs: Number(r.failures) || 0,
        }));
    }

    async failuresOnLaterPrs(organizationId: string, scope: { environmentId: string; repositoryId?: string }): Promise<number> {
        const { rows } = await this.db.query(
            `SELECT count(DISTINCT (kept_check_id, repository_id, pr_number)) AS n FROM runtime.runtime_kept_check_results
             WHERE org_id = $1 AND environment_id = $2 AND ($3::text IS NULL OR repository_id = $3) AND outcome = 'failed' AND pr_number <> source_pr_number`,
            [organizationId, scope.environmentId, scope.repositoryId ?? null],
            { timeoutMs: READ_TIMEOUT_MS },
        );
        return Number((rows as Array<{ n: string | number }>)[0]?.n) || 0;
    }
}
