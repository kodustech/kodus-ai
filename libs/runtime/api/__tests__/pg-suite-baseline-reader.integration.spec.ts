import { Pool } from 'pg';

import { PgSuiteBaselineReader } from '../infrastructure/pg-suite-baseline.reader';

// Opt-in: RUNTIME_IT_DATABASE_URL. The tables are the columns the reader reads (runtime-schema.ts owns the real ones).
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('PgSuiteBaselineReader (real Postgres)', () => {
    const db = `suite_baseline_it_${process.pid}`;
    let pool: Pool;

    beforeAll(async () => {
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE DATABASE ${db}`);
        await admin.end();
        pool = new Pool({ connectionString: url.replace(/\/[^/]*$/, `/${db}`), max: 1 });
        await pool.query(`CREATE SCHEMA runtime;
            CREATE TABLE runtime.runtime_suite_baseline_requests (environment_id text, main_sha text, organization_id text, repository_id text, suite_run_id text, state text, requested_at timestamptz);
            CREATE TABLE runtime.runtime_suite_runs (suite_run_id text PRIMARY KEY, organization_id text)`);
    });

    afterAll(async () => {
        await pool?.end();
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`DROP DATABASE IF EXISTS ${db}`);
        await admin.end();
    });

    it('lists the queued baseline requests whose suite run does not exist, oldest first', async () => {
        const row = (env: string, state: string, ago: string) =>
            pool.query(`INSERT INTO runtime.runtime_suite_baseline_requests VALUES ($1, $2, 'org-a', 'repo-1', $3, $4, now() - $5::interval)`, [env, 'a'.repeat(40), `run-${env}`, state, ago]);
        await row('newer', 'queued', '1 minute');
        await row('older', 'queued', '10 minutes');
        await row('started', 'started', '5 minutes');
        await row('has-run', 'queued', '5 minutes');
        await pool.query(`INSERT INTO runtime.runtime_suite_runs VALUES ('run-has-run', 'org-a')`);
        const out = await new PgSuiteBaselineReader(pool as any).pending(10);
        expect(out).toEqual([
            { organizationId: 'org-a', environmentId: 'older', repositoryId: 'repo-1', mainSha: 'a'.repeat(40), suiteRunId: 'run-older' },
            { organizationId: 'org-a', environmentId: 'newer', repositoryId: 'repo-1', mainSha: 'a'.repeat(40), suiteRunId: 'run-newer' },
        ]);
        expect(await new PgSuiteBaselineReader(pool as any).pending(1)).toHaveLength(1);
    });
});
