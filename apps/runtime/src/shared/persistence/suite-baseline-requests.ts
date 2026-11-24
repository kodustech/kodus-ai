import { randomUUID } from 'crypto';

import type { Pool } from 'pg';

/**
 * The baseline suite runs a template turning ready asks for (docs/runtime/e2e-suites.md section 2.1,
 * `runtime_suite_baseline_requests`). The fleet writes a request when it makes a template (it holds no repository
 * credentials, so the product turns the queued ones into `RuntimeSuiteRequested`, with `suiteRunId` as the run's id so a
 * redelivery finds one run). Coalescing: at most one request is queued per environment; a newer main commit replaces a
 * queued one that has not started (a commit already recorded, queued or started, changes nothing), and a started one finishes and is never asked for again.
 */
export interface BaselineRequest {
    organizationId: string;
    environmentId: string;
    repositoryId: string;
    mainSha: string;
    /** The bake fingerprint of the template the commit was built into. */
    fingerprint: string;
}

export interface PendingBaselineRequest extends BaselineRequest {
    suiteRunId: string;
    requestedAt: Date;
}

export class PgSuiteBaselineRequests {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** One statement: the queued requests of the environment for another commit go, and this commit is recorded unless it already is (queued or started). */
    async request(r: BaselineRequest): Promise<void> {
        await this.pool.query(
            `WITH replaced AS (
               DELETE FROM runtime.runtime_suite_baseline_requests
                WHERE organization_id = $1 AND environment_id = $2 AND state = 'queued' AND main_sha <> $3
                  AND NOT EXISTS (SELECT 1 FROM runtime.runtime_suite_baseline_requests WHERE environment_id = $2 AND main_sha = $3))
             INSERT INTO runtime.runtime_suite_baseline_requests (environment_id, main_sha, organization_id, repository_id, fingerprint, suite_run_id)
             VALUES ($2, $3, $1, $4, $5, $6) ON CONFLICT (environment_id, main_sha) DO NOTHING`,
            [r.organizationId, r.environmentId, r.mainSha, r.repositoryId, r.fingerprint, randomUUID()],
        );
    }

    /** The queued requests, oldest first. */
    async pending(limit: number): Promise<PendingBaselineRequest[]> {
        const r = await this.pool.query(
            `SELECT organization_id, environment_id, repository_id, main_sha, fingerprint, suite_run_id, requested_at
               FROM runtime.runtime_suite_baseline_requests WHERE state = 'queued' ORDER BY requested_at, environment_id LIMIT $1`,
            [limit],
        );
        return r.rows.map((x) => ({ organizationId: x.organization_id, environmentId: x.environment_id, repositoryId: x.repository_id, mainSha: x.main_sha, fingerprint: x.fingerprint, suiteRunId: x.suite_run_id, requestedAt: x.requested_at }));
    }

    /** The command was issued: the request is no longer queued. Only the organization's own request moves. */
    async markStarted(organizationId: string, environmentId: string, mainSha: string): Promise<void> {
        await this.pool.query(
            `UPDATE runtime.runtime_suite_baseline_requests SET state = 'started', started_at = now(), updated_at = now()
              WHERE organization_id = $1 AND environment_id = $2 AND main_sha = $3 AND state = 'queued'`,
            [organizationId, environmentId, mainSha],
        );
    }
}
