import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';
import { PgEnvTemplates } from './env-templates';
import { ensureRuntimeSchema } from './runtime-schema';

// Whether the environment has a template a main host can start from (docs/runtime/e2e-suites.md 9.5). Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'env_templates_ready');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('whether an environment has a ready template (real Postgres)', () => {
    let pool: Pool;
    let templates: PgEnvTemplates;
    const add = (org: string, env: string, state: string, fp: string) =>
        pool.query(`INSERT INTO runtime.runtime_env_templates (org_id, environment_id, pool_id, fingerprint, snapshot_name, state) VALUES ($1, $2, 'boat-1', $3, 'tpl-x', $4)`, [org, env, fp.repeat(16), state]);

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        templates = new PgEnvTemplates(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_env_templates');
    });

    it('is true only for a ready template of that organization and environment', async () => {
        await add('org-a', 'env-1', 'ready', 'a');
        await add('org-a', 'env-2', 'building', 'b');
        await add('org-a', 'env-3', 'replaced', 'c');
        expect(await templates.hasReady('org-a', 'env-1')).toBe(true);
        expect(await templates.hasReady('org-a', 'env-2')).toBe(false);
        expect(await templates.hasReady('org-a', 'env-3')).toBe(false);
        // Another organization never sees it.
        expect(await templates.hasReady('org-b', 'env-1')).toBe(false);
    });
});
