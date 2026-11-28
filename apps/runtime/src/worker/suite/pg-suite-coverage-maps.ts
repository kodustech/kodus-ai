import type { Pool } from 'pg';

import type { CoverageMapRecord } from './coverage-collector';

/**
 * runtime.runtime_suite_coverage_maps (docs/runtime/e2e-suites.md section 6.1): per spec the repository files it exercised on
 * main, one row per (environment, main sha, suite digest). The digest is that of the suite block and the spec list, so a
 * changed suite is another key and the old map is never reused. A map that is `incomplete` (a spec never reported, or its
 * dumps could not be read) is no map for a lookup. Retention runs on every record: the newest MAP_KEEP_COMPLETE complete maps
 * of the environment (the newest and the one before), and an incomplete one only while it is newer than the newest complete one.
 */
export const MAP_KEEP_COMPLETE = 2;

/** What a PR run reads: the newest complete map of the environment. */
export interface StoredCoverageMap {
    mainSha: string;
    suiteDigest: string;
    finishedAt: Date;
    specs: Record<string, string[]>;
}

export class PgSuiteCoverageMaps {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** The first complete map of a key stays; an incomplete one is replaced by a complete one and by nothing else. `stored` says whether the row changed. */
    async record(m: CoverageMapRecord): Promise<{ stored: boolean }> {
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_coverage_maps AS t (organization_id, environment_id, main_sha, suite_digest, status, specs, finished_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (environment_id, main_sha, suite_digest) DO UPDATE SET status = EXCLUDED.status, specs = EXCLUDED.specs, finished_at = EXCLUDED.finished_at
             WHERE t.organization_id = EXCLUDED.organization_id AND t.status = 'incomplete' AND EXCLUDED.status = 'complete'`,
            [m.organizationId, m.environmentId, m.mainSha, m.suiteDigest, m.status, JSON.stringify(m.specs), m.finishedAt],
        );
        await this.prune(m.organizationId, m.environmentId);
        return { stored: (r.rowCount ?? 0) > 0 };
    }

    /** The newest complete map of the environment, whatever its digest: selection compares the digest and says why it will not use it. */
    async newest(organizationId: string, environmentId: string): Promise<StoredCoverageMap | undefined> {
        const r = await this.pool.query(
            `SELECT main_sha, suite_digest, finished_at, specs FROM runtime.runtime_suite_coverage_maps
              WHERE organization_id = $1 AND environment_id = $2 AND status = 'complete' ORDER BY finished_at DESC, main_sha LIMIT 1`,
            [organizationId, environmentId],
        );
        const x = r.rows[0];
        return x ? { mainSha: x.main_sha, suiteDigest: x.suite_digest, finishedAt: x.finished_at, specs: x.specs } : undefined;
    }

    private async prune(organizationId: string, environmentId: string): Promise<void> {
        await this.pool.query(
            `WITH kept AS (
                 SELECT main_sha, suite_digest, finished_at FROM runtime.runtime_suite_coverage_maps
                  WHERE organization_id = $1 AND environment_id = $2 AND status = 'complete' ORDER BY finished_at DESC, main_sha LIMIT $3)
             DELETE FROM runtime.runtime_suite_coverage_maps m
              WHERE m.organization_id = $1 AND m.environment_id = $2
                AND NOT EXISTS (SELECT 1 FROM kept k WHERE k.main_sha = m.main_sha AND k.suite_digest = m.suite_digest)
                AND NOT (m.status = 'incomplete' AND m.finished_at > COALESCE((SELECT max(finished_at) FROM kept), '-infinity'::timestamptz))`,
            [organizationId, environmentId, MAP_KEEP_COMPLETE],
        );
    }
}
