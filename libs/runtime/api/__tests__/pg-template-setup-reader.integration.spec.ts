import { Pool } from 'pg';

import { PgTemplateSetupReader } from '../infrastructure/pg-template-setup.reader';

// Opt-in: RUNTIME_IT_DATABASE_URL. The tables are the columns the reader reads (runtime-schema.ts owns the real ones).
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('PgTemplateSetupReader (real Postgres)', () => {
    const db = `template_setup_it_${process.pid}`;
    let pool: Pool;

    beforeAll(async () => {
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE DATABASE ${db}`);
        await admin.end();
        pool = new Pool({ connectionString: url.replace(/\/[^/]*$/, `/${db}`), max: 1 });
        await pool.query(`CREATE SCHEMA runtime;
            CREATE TABLE runtime.runtime_env_templates (org_id text, environment_id text, pool_id text, fingerprint text, state text, setup_key text, setup_requested_at timestamptz);
            CREATE TABLE runtime.runtime_environment_setups (environment_id text PRIMARY KEY, organization_id text, setup_key text)`);
    });

    afterAll(async () => {
        await pool?.end();
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`DROP DATABASE IF EXISTS ${db}`);
        await admin.end();
    });

    it('lists the building templates asked for in the last hour whose setup record does not hold the key', async () => {
        const row = (env: string, state: string, key: string | null, ago: string) =>
            pool.query(`INSERT INTO runtime.runtime_env_templates VALUES ('org-a', $1, 'p', $1, $2, $3, now() - $4::interval)`, [env, state, key, ago]);
        await row('pending', 'building', 'template:org-a/pending:tpl-1', '5 minutes');
        await row('has-record', 'building', 'template:org-a/has-record:tpl-1', '5 minutes');
        await row('old', 'building', 'template:org-a/old:tpl-1', '2 hours');
        await row('no-key', 'building', null, '5 minutes');
        await row('ready', 'ready', 'template:org-a/ready:tpl-1', '5 minutes');
        await pool.query(`INSERT INTO runtime.runtime_environment_setups VALUES ('has-record', 'org-a', 'template:org-a/has-record:tpl-1')`);
        expect(await new PgTemplateSetupReader(pool as any).pending(10)).toEqual([{ organizationId: 'org-a', environmentId: 'pending', key: 'template:org-a/pending:tpl-1' }]);
    });
});
