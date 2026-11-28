import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgKeptCheckResults } from './pg-kept-check-results';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'kept_check_results');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const K = '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d';

(skip ? describe.skip : describe)('runtime_kept_check_results (real Postgres)', () => {
    let pool: Pool;
    let store: PgKeptCheckResults;
    const scope = { orgId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', runId: 'run-1', prNumber: 9 };

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgKeptCheckResults(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_kept_check_results');
    });

    it('keeps one row per Run and kept check, however often the step is retried', async () => {
        const rows = [{ keptCheckId: K, outcome: 'failed' as const, sourcePrNumber: 7 }];
        await store.record(scope, rows);
        await store.record(scope, rows);
        const { rows: got } = await pool.query('SELECT org_id, repository_id, pr_number, source_pr_number, outcome, stale_reason FROM runtime.runtime_kept_check_results');
        expect(got).toEqual([{ org_id: 'org-a', repository_id: 'repo-1', pr_number: 9, source_pr_number: 7, outcome: 'failed', stale_reason: null }]);
    });

    it('keeps the stale reason with a stale outcome and refuses an outcome it does not know', async () => {
        await store.record({ ...scope, runId: 'run-2' }, [{ keptCheckId: K, outcome: 'stale', staleReason: 'route_gone', sourcePrNumber: 7 }]);
        const { rows } = await pool.query('SELECT outcome, stale_reason FROM runtime.runtime_kept_check_results');
        expect(rows).toEqual([{ outcome: 'stale', stale_reason: 'route_gone' }]);
        await expect(store.record({ ...scope, runId: 'run-3' }, [{ keptCheckId: K, outcome: 'maybe' as never, sourcePrNumber: 7 }])).rejects.toThrow();
    });
});
