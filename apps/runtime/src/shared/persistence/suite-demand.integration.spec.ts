import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';
import { ensureRuntimeSchema } from './runtime-schema';
import { PgSuiteDemand } from './suite-demand';

// docs/runtime/e2e-suites.md section 5: N demand rows per suite run, one host each. Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_demand');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const POOL = 'boat-eu-perrun';

(skip ? describe.skip : describe)('the demand a suite run makes on a perRun pool (real Postgres)', () => {
    let pool: Pool;
    let demand: PgSuiteDemand;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        demand = new PgSuiteDemand(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_pool_demand');
        await pool.query('DELETE FROM runtime.runtime_cell_sessions');
    });

    const keys = async () => (await pool.query(`SELECT bound_key, environment_id, run_id, expires_at > now() AS live FROM runtime.runtime_pool_demand ORDER BY bound_key`)).rows;
    const ask = (shards: number[], over: Partial<Parameters<PgSuiteDemand['request']>[0]> = {}) => demand.request({ poolId: POOL, organizationId: 'org-a', environmentId: 'env-1', suiteRunId: 'sr-1', shards, ...over });

    it('writes one demand row per shard, so the fleet starts every host at once, each bound to its own key', async () => {
        await ask([0, 1, 2]);
        expect(await keys()).toEqual([0, 1, 2].map((n) => ({ bound_key: `suite:org-a/sr-1/${n}`, environment_id: 'env-1', run_id: 'sr-1', live: true })));
    });

    it('asking again keeps one row per shard and keeps them alive: the host stays while the suite lives', async () => {
        await ask([0, 1]);
        await pool.query(`UPDATE runtime.runtime_pool_demand SET expires_at = now() + interval '5 seconds'`);
        await ask([0, 1]);
        expect(await keys()).toHaveLength(2);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM runtime.runtime_pool_demand WHERE expires_at > now() + interval '60 seconds'`);
        expect(rows[0].n).toBe(2);
    });

    it("another organization's suite run, even with the same id, has demand rows of its own", async () => {
        await ask([0]);
        await ask([0], { organizationId: 'org-b' });
        expect((await keys()).map((k) => k.bound_key)).toEqual(['suite:org-a/sr-1/0', 'suite:org-b/sr-1/0']);
    });

    it('says which shards have a host, which wait for one and which the fleet could not make', async () => {
        await ask([0, 1, 2]);
        await pool.query(`UPDATE runtime.runtime_pool_demand SET failed_at = now(), failure = 'registration_timeout' WHERE bound_key = 'suite:org-a/sr-1/1'`);
        await pool.query(
            `INSERT INTO runtime.runtime_cell_sessions (cell_id, replica_id, replica_url, owner, driver, bound_key, pool_id) VALUES ($1, 'r', 'u', 'kodus', 'fake', 'suite:org-a/sr-1/0', $2)`,
            [`cell-${randomUUID()}`, POOL],
        );
        expect(await demand.status('org-a', 'sr-1')).toEqual([
            { shard: 0, state: 'ready' },
            { shard: 1, state: 'failed', failure: 'registration_timeout' },
            { shard: 2, state: 'starting' },
        ]);
        expect(await demand.status('org-b', 'sr-1')).toEqual([]);
    });

    it('ends the demand of one suite run at once, so its hosts are retired without waiting for the time to live; other runs keep theirs', async () => {
        await ask([0, 1]);
        await ask([0], { suiteRunId: 'sr-2' });
        await demand.end('org-a', 'sr-1');
        expect((await keys()).map((k) => [k.bound_key, k.live])).toEqual([
            ['suite:org-a/sr-1/0', false],
            ['suite:org-a/sr-1/1', false],
            ['suite:org-a/sr-2/0', true],
        ]);
        // Ended twice is the same; an org that does not own the run ends nothing.
        await demand.end('org-a', 'sr-1');
        await demand.end('org-b', 'sr-2');
        expect((await keys())[2].live).toBe(true);
    });
});
