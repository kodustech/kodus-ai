import { Pool } from 'pg';

import { NORMALIZER_VERSION } from '@libs/runtime/gate';

import { applyRetention, ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgStabilityHistory, STABILITY_READ_PER_KEY } from './pg-stability-history';
import type { StabilityOutcome } from './ports';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'stability_history');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const outcome = (over: Partial<StabilityOutcome> = {}): StabilityOutcome => ({
    probeKey: 'http GET /orders',
    probeIndex: 0,
    normalizerVersion: NORMALIZER_VERSION,
    unstableFields: ['json.id'],
    verdict: 'not_reproduced',
    baseRounds: 2,
    prRounds: 1,
    ...over,
});

(skip ? describe.skip : describe)('runtime_stability (real Postgres, ADR-050)', () => {
    let pool: Pool;
    let store: PgStabilityHistory;
    const env = { orgId: 'org-a', environmentId: 'env-1' };

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgStabilityHistory(pool);
    });

    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_stability');
    });

    it('reads back a probe shape only within its org and environment', async () => {
        await store.record({ ...env, runId: 'r1' }, [outcome()]);
        await store.record({ orgId: 'org-b', environmentId: 'env-1', runId: 'r2' }, [outcome({ unstableFields: ['json.other'] })]);
        await store.record({ orgId: 'org-a', environmentId: 'env-2', runId: 'r3' }, [outcome({ unstableFields: ['json.env2'] })]);

        expect(await store.read(env, ['http GET /orders', 'http GET /none'])).toEqual({
            'http GET /orders': [{ normalizerVersion: NORMALIZER_VERSION, unstableFields: ['json.id'], verdict: 'not_reproduced' }],
            'http GET /none': [],
        });
    });

    it('a retried record writes nothing twice', async () => {
        await store.record({ ...env, runId: 'r1' }, [outcome()]);
        await store.record({ ...env, runId: 'r1' }, [outcome({ unstableFields: ['json.changed'] })]);
        expect((await store.read(env, ['http GET /orders']))['http GET /orders']).toHaveLength(1);
    });

    it('reads at most the most recent Runs of a key, and retention removes what is past 90 days', async () => {
        for (let i = 0; i < STABILITY_READ_PER_KEY + 3; i++) await store.record({ ...env, runId: `r${i}` }, [outcome()]);
        expect((await store.read(env, ['http GET /orders']))['http GET /orders']).toHaveLength(STABILITY_READ_PER_KEY);

        await pool.query(`UPDATE runtime.runtime_stability SET recorded_at = now() - interval '91 days' WHERE run_id = 'r0'`);
        expect(await applyRetention(pool)).toBeGreaterThanOrEqual(1);
        expect((await pool.query(`SELECT 1 FROM runtime.runtime_stability WHERE run_id = 'r0'`)).rowCount).toBe(0);
    });
});
