import { Pool } from 'pg';

import { PgRuntimeEgressReader } from '../infrastructure/pg-runtime-egress.reader';
import { RuntimeReadDb } from '../infrastructure/runtime-read-db';

// Opt-in: RUNTIME_IT_DATABASE_URL. A rolling deploy may run the API before the Runtime applied migration 32: the
// reader then reads approvals as they were (passthrough), the defaults for the settings and no audit.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('PgRuntimeEgressReader before migration 32 (real Postgres)', () => {
    const schema = `runtime`;
    let pool: Pool;
    const db = `egress_reader_it_${process.pid}`;
    let reader: PgRuntimeEgressReader;
    let readDb: RuntimeReadDb;

    beforeAll(async () => {
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE DATABASE ${db}`);
        await admin.end();
        const dbUrl = url.replace(/\/[^/]*$/, `/${db}`);
        pool = new Pool({ connectionString: dbUrl, max: 1 });
        await pool.query(`CREATE SCHEMA ${schema};
            CREATE TABLE runtime.runtime_egress_approvals (environment_id text, host text, organization_id text, approved_by text, approved_at timestamptz)`);
        await pool.query(`INSERT INTO runtime.runtime_egress_approvals VALUES ('env-1', 'api.old.example', 'org-a', 'u', now())`);
        readDb = new RuntimeReadDb(dbUrl);
        reader = new PgRuntimeEgressReader(readDb);
    });

    afterAll(async () => {
        await readDb?.onModuleDestroy();
        await pool?.end();
        const admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`DROP DATABASE IF EXISTS ${db}`);
        await admin.end();
    });

    it('reads the old rows as passthrough, the default settings and no audit', async () => {
        expect(await reader.approvals('org-a', 'env-1')).toMatchObject([{ host: 'api.old.example', mode: 'passthrough', source: 'blocker' }]);
        expect(await reader.settings('org-a')).toEqual({ recommendedEnabled: true, whoMayAdd: 'owners' });
        expect(await reader.audit('org-a')).toEqual([]);
    });
});
