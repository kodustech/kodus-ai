import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgSuiteSpecStats } from './pg-suite-spec-stats';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_spec_stats');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const SHA = 'a'.repeat(40);

(skip ? describe.skip : describe)('runtime_suite_spec_stats (real Postgres)', () => {
    let pool: Pool;
    let stats: PgSuiteSpecStats;
    const scope = { organizationId: 'org-a', environmentId: 'env-1' };

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        stats = new PgSuiteSpecStats(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_spec_stats');
    });

    it('a passing spec stores its duration, and a later pass moves the median toward the new one', async () => {
        await stats.record(scope, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 10_000 }]);
        expect(await stats.read(scope, ['a.cy.ts'])).toEqual({ 'a.cy.ts': { p50Ms: 10_000 } });
        await stats.record(scope, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 20_000 }]);
        const { p50Ms } = (await stats.read(scope, ['a.cy.ts']))['a.cy.ts'];
        expect(p50Ms).toBeGreaterThan(10_000);
        expect(p50Ms).toBeLessThan(20_000);
    });

    it('a failed spec stores the wall time it cost its shard, like a passing one; a skipped spec changes nothing', async () => {
        await stats.record(scope, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 10_000 }]);
        await stats.record(scope, SHA, [
            { spec: 'a.cy.ts', status: 'failed', durationMs: 20_000 },
            { spec: 'b.cy.ts', status: 'failed', durationMs: 180_000 },
            { spec: 'c.cy.ts', status: 'skipped', durationMs: 0 },
        ]);
        const read = await stats.read(scope, ['a.cy.ts', 'b.cy.ts', 'c.cy.ts']);
        expect(read['b.cy.ts']).toEqual({ p50Ms: 180_000 });
        expect(read['a.cy.ts'].p50Ms).toBeGreaterThan(10_000);
        expect(read['a.cy.ts'].p50Ms).toBeLessThan(20_000);
        expect(read).not.toHaveProperty('c.cy.ts');
        const { rows } = await pool.query('SELECT spec, samples FROM runtime.runtime_suite_spec_stats ORDER BY spec');
        expect(rows).toEqual([{ spec: 'a.cy.ts', samples: 2 }, { spec: 'b.cy.ts', samples: 1 }]);
    });

    it('keeps every environment apart, and reads only the specs asked for', async () => {
        await stats.record(scope, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 5_000 }, { spec: 'b.cy.ts', status: 'passed', durationMs: 7_000 }]);
        await stats.record({ organizationId: 'org-a', environmentId: 'env-2' }, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 90_000 }]);
        expect(await stats.read(scope, ['a.cy.ts'])).toEqual({ 'a.cy.ts': { p50Ms: 5_000 } });
        expect(await stats.read({ organizationId: 'org-a', environmentId: 'env-2' }, ['a.cy.ts', 'b.cy.ts'])).toEqual({ 'a.cy.ts': { p50Ms: 90_000 } });
        // Another organization never reads it, even with the same environment id.
        expect(await stats.read({ organizationId: 'org-b', environmentId: 'env-1' }, ['a.cy.ts'])).toEqual({});
    });

    it('two writers recording the same spec at once lose no sample', async () => {
        await Promise.all([1, 2, 3, 4].map(() => stats.record(scope, SHA, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 1_000 }])));
        const { rows } = await pool.query('SELECT samples FROM runtime.runtime_suite_spec_stats');
        expect(rows).toEqual([{ samples: 4 }]);
    });
});
