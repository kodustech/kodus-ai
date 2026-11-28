import { Pool } from 'pg';

import { recordPoolDemand } from '../../shared/persistence/cell-directory';
import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgRunClaims } from './pg-run-claims';

// Opt-in: RUNTIME_IT_DATABASE_URL. A Run that ends ends its demand for hosts (the worker writes those rows), so the fleet
// retires them as soon as no claim holds them instead of 120 s later.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'run_claims');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('ending a Run\'s demand for hosts (real Postgres)', () => {
    let pool: Pool;
    let claims: PgRunClaims;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 2 });
        await ensureRuntimeSchema(pool);
        claims = new PgRunClaims(pool);
    }, 60_000);
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const ask = (organizationId: string, boundKey: string) => recordPoolDemand(pool, { poolId: 'boat-dev', boundKey, organizationId, runId: 'x' });
    const live = async () => (await pool.query(`SELECT bound_key FROM runtime.runtime_pool_demand WHERE expires_at > now() ORDER BY bound_key`)).rows.map((r) => r.bound_key as string);

    it("ends the demand of the Run's whole-Run key and of each side, and no other Run's, organization's or kind's", async () => {
        await ask('org-a', 'run:org-a/run-1');
        await ask('org-a', 'run:org-a/run-1/base');
        await ask('org-a', 'run:org-a/run-1/pr');
        await ask('org-a', 'run:org-a/run-10/pr');
        await ask('org-a', 'run:org-a/run-1x');
        await ask('org-b', 'run:org-b/run-1/pr');
        await ask('org-a', 'suite:org-a/run-1/0');
        await claims.endDemand('org-b', 'run-1-not-theirs');
        expect(await live()).toHaveLength(7);
        await claims.endDemand('org-a', 'run-1');
        expect(await live()).toEqual(['run:org-a/run-10/pr', 'run:org-a/run-1x', 'run:org-b/run-1/pr', 'suite:org-a/run-1/0']);
    });
});
