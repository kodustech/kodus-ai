import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';
import { applyRetention, ensureRuntimeSchema } from './runtime-schema';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'run_retention');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const RUN_DAYS = 365;

(skip ? describe.skip : describe)('Run retention (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        for (const t of ['runtime_runs', 'runtime_pr_run_generations', 'runtime_fork_approvals', 'runtime_previews', 'runtime_claims', 'runtime_kept_check_results'])
            await pool.query(`DELETE FROM runtime.${t}`);
    });

    const run = (runId: string, state: string, endedDaysAgo: number) =>
        pool.query(
            `INSERT INTO runtime.runtime_runs (run_id, organization_id, repository_id, pr_number, head_sha, environment_id, state, finished_at, updated_at)
             VALUES ($1, 'org-a', 'repo-1', $2, $1, 'env-1', $3, $4, $4)`,
            [runId, Math.floor(Math.random() * 1_000_000), state, ago(endedDaysAgo)],
        );
    const children = async (runId: string) => {
        await pool.query(`INSERT INTO runtime.runtime_pr_run_generations (organization_id, run_id, repository_id, pr_number, generation, head_sha) VALUES ('org-a', $1, 'repo-1', 1, 1, $1)`, [runId]);
        await pool.query(`INSERT INTO runtime.runtime_fork_approvals (key, run_id, head_sha, approver, approved_at) VALUES ($2, $1, $1, 'u', now())`, [runId, `${runId}:key`]);
        await pool.query(
            `INSERT INTO runtime.runtime_previews (preview_id, org_id, environment_id, repository_id, repository_full_name, run_id, side, sha, host, state, opened_by, created_at, updated_at, expires_at)
             VALUES ($2, 'org-a', 'env-1', 'repo-1', 'acme/app', $1, 'pr', $1, $2, 'expired', 'u', now(), now(), now())`,
            [runId, `pv-${runId}`],
        );
    };
    const left = async (table: string, column = 'run_id') => (await pool.query(`SELECT ${column} AS id FROM runtime.${table} ORDER BY 1`)).rows.map((r) => r.id as string);

    it('deletes an old ended Run with its children, and keeps a recent one and a Run that is not terminal', async () => {
        await run('old', 'regression', 400);
        await run('recent', 'regression', 10);
        await run('old-live', 'testing', 500);
        for (const id of ['old', 'recent', 'old-live']) await children(id);

        const removed = await applyRetention(pool, 30, 10, RUN_DAYS);

        expect(removed).toBeGreaterThanOrEqual(1);
        expect(await left('runtime_runs')).toEqual(['old-live', 'recent']);
        expect(await left('runtime_pr_run_generations')).toEqual(['old-live', 'recent']);
        expect(await left('runtime_fork_approvals')).toEqual(['old-live', 'recent']);
        expect(await left('runtime_previews')).toEqual(['old-live', 'recent']);
    });

    it('keeps an old ended Run a live claim or a kept check result still names, and deletes it once they are gone', async () => {
        await run('claimed', 'cancelled', 400);
        await run('kept', 'no_regressions', 400);
        await run('plain', 'errored', 400);
        await pool.query(
            `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, run_id, side, state, lease_expires_at, hard_expires_at) VALUES ('c1', 'cell-1', 'org-a', 'claimed', 'pr', 'bound', now(), now())`,
        );
        await pool.query(
            `INSERT INTO runtime.runtime_kept_check_results (org_id, environment_id, repository_id, run_id, pr_number, kept_check_id, source_pr_number, outcome, recorded_at)
             VALUES ('org-a', 'env-1', 'repo-1', 'kept', 2, 'kc-1', 1, 'passed', now())`,
        );

        await applyRetention(pool, 30, 10, RUN_DAYS);
        expect(await left('runtime_runs')).toEqual(['claimed', 'kept']);

        await pool.query(`UPDATE runtime.runtime_claims SET released_at = now() WHERE claim_id = 'c1'`);
        await pool.query(`DELETE FROM runtime.runtime_kept_check_results`);
        await applyRetention(pool, 30, 10, RUN_DAYS);
        expect(await left('runtime_runs')).toEqual([]);
    });

    it('drains a backlog larger than one batch', async () => {
        for (let i = 0; i < 5; i++) await run(`bulk-${i}`, 'timed_out', 400);
        await applyRetention(pool, 30, 2, RUN_DAYS);
        expect(await left('runtime_runs')).toEqual([]);
    });
});
