import { Pool } from 'pg';

import { PgSuiteShadowReader } from '../infrastructure/pg-suite-shadow.reader';

// Opt-in: RUNTIME_IT_DATABASE_URL. The tables are the columns the reader reads (runtime-schema.ts owns the real ones).
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('PgSuiteShadowReader (real Postgres)', () => {
    const db = `suite_shadow_it_${process.pid}`;
    let pool: Pool;

    beforeAll(async () => {
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE DATABASE ${db}`);
        await admin.end();
        pool = new Pool({ connectionString: url.replace(/\/[^/]*$/, `/${db}`), max: 1 });
        await pool.query(`CREATE SCHEMA runtime;
            CREATE TABLE runtime.runtime_suite_shadows (shadow_run_id text, organization_id text, environment_id text, repository_id text, pr_number int, pr_sha text, merge_base text, main_sha text, changed_files jsonb, removed_files jsonb, state text, requested_at timestamptz);
            CREATE TABLE runtime.runtime_suite_runs (suite_run_id text PRIMARY KEY, organization_id text)`);
    });
    afterAll(async () => {
        await pool?.end();
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`DROP DATABASE IF EXISTS ${db}`);
        await admin.end();
    });

    it('lists the queued shadows whose suite run does not exist, oldest first, with what the command needs', async () => {
        const row = (id: string, state: string, ago: string) =>
            pool.query(`INSERT INTO runtime.runtime_suite_shadows VALUES ($1, 'org-a', 'env-1', 'repo-1', 7, $2, $3, $3, '["src/a.ts"]', '["old.cy.ts"]', $4, now() - $5::interval)`, [id, 'b'.repeat(40), 'a'.repeat(40), state, ago]);
        await row('newer', 'queued', '1 minute');
        await row('older', 'queued', '10 minutes');
        await row('started', 'started', '5 minutes');
        await row('has-run', 'queued', '5 minutes');
        await pool.query(`INSERT INTO runtime.runtime_suite_runs VALUES ('has-run', 'org-a')`);
        const out = await new PgSuiteShadowReader(pool as any).pending(10);
        expect(out.map((x) => x.shadowRunId)).toEqual(['older', 'newer']);
        expect(out[0]).toEqual({ organizationId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', shadowRunId: 'older', prNumber: 7, prSha: 'b'.repeat(40), mergeBase: 'a'.repeat(40), mainSha: 'a'.repeat(40), changedFiles: ['src/a.ts'], removedFiles: ['old.cy.ts'] });
        expect(await new PgSuiteShadowReader(pool as any).pending(1)).toHaveLength(1);
    });
});
