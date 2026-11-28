import type { Pool } from 'pg';

import { MAIN_HISTORY_RUNS, type MainObservation } from '@libs/runtime/suite';

/**
 * runtime.runtime_suite_main_observations (docs/runtime/e2e-suites.md 7.2, lazy baseline): what main said of each spec, one row per
 * spec per run (a baseline sees every spec, the main re-run of a PR the specs that failed on it). Append-only, so one commit can hold
 * both outcomes (a flaky spec). `at` answers the stored result of a spec at the first of the given commits that has one, for the same
 * suite digest; `history` is the spec's newest runs whatever the digest, for the classifier. Recording is idempotent per (run, spec) and
 * prunes the environment to the newest `HISTORY_KEEP` rows per spec and `HISTORY_DAYS` days.
 */
export const HISTORY_KEEP = 30;
export const HISTORY_DAYS = 30;

export interface MainTestResult {
    title: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    errorSignature?: string;
}

export interface MainObservationRow {
    spec: string;
    status: 'passed' | 'failed';
    errorSignature?: string;
    tests: MainTestResult[];
}

export interface MainRecord {
    organizationId: string;
    environmentId: string;
    suiteRunId: string;
    mainSha: string;
    suiteDigest: string;
    source: 'baseline' | 'rerun';
    observedAt: Date;
    rows: readonly MainObservationRow[];
}

export interface StoredMainResult {
    mainSha: string;
    observations: Array<MainObservation & { tests: MainTestResult[] }>;
}

export class PgSuiteMainResults {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    async record(r: MainRecord): Promise<void> {
        if (r.rows.length === 0) return;
        await this.pool.query(
            `INSERT INTO runtime.runtime_suite_main_observations (suite_run_id, organization_id, environment_id, main_sha, suite_digest, spec, status, error_signature, tests, source, observed_at)
             SELECT $1, $2, $3, $4, $5, o.spec, o.status, o.sig, o.tests::jsonb, $6, $7
               FROM unnest($8::text[], $9::text[], $10::text[], $11::text[]) AS o(spec, status, sig, tests)
             ON CONFLICT (suite_run_id, spec) DO NOTHING`,
            [r.suiteRunId, r.organizationId, r.environmentId, r.mainSha, r.suiteDigest, r.source, r.observedAt, r.rows.map((x) => x.spec), r.rows.map((x) => x.status), r.rows.map((x) => x.errorSignature ?? null), r.rows.map((x) => JSON.stringify(x.tests))],
        );
        await this.pool.query(
            `DELETE FROM runtime.runtime_suite_main_observations
              WHERE organization_id = $1 AND environment_id = $2
                AND (observed_at < $3::timestamptz - make_interval(days => $4)
                     OR id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY spec ORDER BY observed_at DESC, id DESC) AS rn
                                                 FROM runtime.runtime_suite_main_observations WHERE organization_id = $1 AND environment_id = $2) t WHERE t.rn > $5))`,
            [r.organizationId, r.environmentId, r.observedAt, HISTORY_DAYS, HISTORY_KEEP],
        );
    }

    /** Per spec, every run at the first of `shas` (the merge base first, then the template's commit) that has one, for this suite digest. */
    async at(organizationId: string, environmentId: string, suiteDigest: string, shas: readonly string[], specs: readonly string[]): Promise<Map<string, StoredMainResult>> {
        const out = new Map<string, StoredMainResult>();
        if (shas.length === 0 || specs.length === 0) return out;
        const r = await this.pool.query(
            `WITH hits AS (
               SELECT o.spec, o.main_sha, o.status, o.error_signature, o.tests, o.observed_at, w.pos
                 FROM runtime.runtime_suite_main_observations o JOIN unnest($4::text[]) WITH ORDINALITY AS w(sha, pos) ON w.sha = o.main_sha
                WHERE o.organization_id = $1 AND o.environment_id = $2 AND o.suite_digest = $3 AND o.spec = ANY($5::text[])),
             best AS (SELECT spec, min(pos) AS pos FROM hits GROUP BY spec)
             SELECT h.* FROM hits h JOIN best b ON b.spec = h.spec AND b.pos = h.pos ORDER BY h.spec, h.observed_at`,
            [organizationId, environmentId, suiteDigest, [...shas], [...specs]],
        );
        for (const x of r.rows as Array<{ spec: string; main_sha: string; status: 'passed' | 'failed'; error_signature: string | null; tests: MainTestResult[]; observed_at: Date }>) {
            const held = out.get(x.spec) ?? { mainSha: x.main_sha, observations: [] };
            held.observations.push({ mainSha: x.main_sha, status: x.status, ...(x.error_signature ? { errorSignature: x.error_signature } : {}), observedAt: x.observed_at.getTime(), tests: x.tests });
            out.set(x.spec, held);
        }
        return out;
    }

    /** The newest `MAIN_HISTORY_RUNS` runs of each spec on main, whatever the suite digest. */
    async history(organizationId: string, environmentId: string, specs: readonly string[]): Promise<Map<string, MainObservation[]>> {
        const out = new Map<string, MainObservation[]>();
        if (specs.length === 0) return out;
        const r = await this.pool.query(
            `SELECT spec, main_sha, status, error_signature, observed_at FROM (
               SELECT *, row_number() OVER (PARTITION BY spec ORDER BY observed_at DESC, id DESC) AS rn
                 FROM runtime.runtime_suite_main_observations WHERE organization_id = $1 AND environment_id = $2 AND spec = ANY($3::text[])) t
              WHERE rn <= $4 ORDER BY spec, observed_at DESC`,
            [organizationId, environmentId, [...specs], MAIN_HISTORY_RUNS],
        );
        for (const x of r.rows as Array<{ spec: string; main_sha: string; status: 'passed' | 'failed'; error_signature: string | null; observed_at: Date }>) {
            const list = out.get(x.spec) ?? [];
            list.push({ mainSha: x.main_sha, status: x.status, ...(x.error_signature ? { errorSignature: x.error_signature } : {}), observedAt: x.observed_at.getTime() });
            out.set(x.spec, list);
        }
        return out;
    }
}
