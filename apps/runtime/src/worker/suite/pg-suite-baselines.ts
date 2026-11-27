import type { Pool } from 'pg';

/**
 * runtime.runtime_suite_baselines (docs/runtime/e2e-suites.md section 7.1): the per-spec result of the whole suite on
 * one main commit, unique per (environment, main sha, suite digest). A failed baseline (infra) is `incomplete` and
 * is not a baseline for any lookup. Retention runs on every record: the newest BASELINE_KEEP_COMMITS rows of the
 * environment, nothing older than BASELINE_KEEP_DAYS, and the newest complete one is never deleted.
 */
export const BASELINE_KEEP_COMMITS = 50;
export const BASELINE_KEEP_DAYS = 30;

export interface BaselineSpec {
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    errorSignature?: string;
}

export interface BaselineRecord {
    organizationId: string;
    environmentId: string;
    mainSha: string;
    suiteDigest: string;
    status: 'complete' | 'incomplete';
    specs: Record<string, BaselineSpec>;
    finishedAt: Date;
}

const toRecord = (x: Record<string, any>): BaselineRecord => ({
    organizationId: x.organization_id,
    environmentId: x.environment_id,
    mainSha: x.main_sha,
    suiteDigest: x.suite_digest,
    status: x.status,
    specs: x.specs,
    finishedAt: x.finished_at,
});

export class PgSuiteBaselines {
    constructor(
        private readonly pool: Pick<Pool, 'query'>,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /**
     * Stores the baseline. The first complete one of a key stays (a second run of the same commit changes nothing); an
     * incomplete one is replaced by a complete one and by nothing else. `stored` says whether the row changed.
     */
    async record(b: BaselineRecord): Promise<{ stored: boolean }> {
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_baselines AS t (organization_id, environment_id, main_sha, suite_digest, status, specs, finished_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (environment_id, main_sha, suite_digest) DO UPDATE SET status = EXCLUDED.status, specs = EXCLUDED.specs, finished_at = EXCLUDED.finished_at
             WHERE t.organization_id = EXCLUDED.organization_id AND t.status = 'incomplete' AND EXCLUDED.status = 'complete'`,
            [b.organizationId, b.environmentId, b.mainSha, b.suiteDigest, b.status, JSON.stringify(b.specs), b.finishedAt],
        );
        await this.prune(b.organizationId, b.environmentId);
        return { stored: (r.rowCount ?? 0) > 0 };
    }

    /** The complete baseline of exactly this commit and suite digest. */
    async find(organizationId: string, environmentId: string, mainSha: string, suiteDigest: string): Promise<BaselineRecord | null> {
        return (await this.findAmong(organizationId, environmentId, suiteDigest, [mainSha]));
    }

    /** The first of `shas` (nearest ancestor first) that has a complete baseline for the digest. */
    async findAmong(organizationId: string, environmentId: string, suiteDigest: string, shas: readonly string[]): Promise<BaselineRecord | null> {
        if (shas.length === 0) return null;
        const r = await this.pool.query(
            `SELECT b.* FROM runtime.runtime_suite_baselines b JOIN unnest($4::text[]) WITH ORDINALITY AS w(sha, pos) ON w.sha = b.main_sha
              WHERE b.organization_id = $1 AND b.environment_id = $2 AND b.suite_digest = $3 AND b.status = 'complete' ORDER BY w.pos LIMIT 1`,
            [organizationId, environmentId, suiteDigest, [...shas]],
        );
        return r.rows[0] ? toRecord(r.rows[0]) : null;
    }

    /** The environment's newest complete baseline (any digest): what the lazy rule asks whether a new main commit needs a full run after. */
    async newest(organizationId: string, environmentId: string): Promise<{ mainSha: string; suiteDigest: string; finishedAt: Date } | null> {
        const r = await this.pool.query(
            `SELECT main_sha, suite_digest, finished_at FROM runtime.runtime_suite_baselines WHERE organization_id = $1 AND environment_id = $2 AND status = 'complete' ORDER BY finished_at DESC LIMIT 1`,
            [organizationId, environmentId],
        );
        const x = r.rows[0];
        return x ? { mainSha: x.main_sha, suiteDigest: x.suite_digest, finishedAt: x.finished_at } : null;
    }

    private async prune(organizationId: string, environmentId: string): Promise<void> {
        await this.pool.query(
            `DELETE FROM runtime.runtime_suite_baselines b
              WHERE b.organization_id = $1 AND b.environment_id = $2
                AND (b.finished_at < $3::timestamptz - make_interval(days => $4)
                     OR (b.main_sha, b.suite_digest) NOT IN (
                          SELECT main_sha, suite_digest FROM runtime.runtime_suite_baselines
                           WHERE organization_id = $1 AND environment_id = $2 ORDER BY finished_at DESC, main_sha LIMIT $5))
                AND NOT EXISTS (
                      SELECT 1 FROM (SELECT main_sha, suite_digest FROM runtime.runtime_suite_baselines
                                      WHERE organization_id = $1 AND environment_id = $2 AND status = 'complete'
                                      ORDER BY finished_at DESC, main_sha LIMIT 1) keep
                       WHERE keep.main_sha = b.main_sha AND keep.suite_digest = b.suite_digest)`,
            [organizationId, environmentId, this.now(), BASELINE_KEEP_DAYS, BASELINE_KEEP_COMMITS],
        );
    }
}
