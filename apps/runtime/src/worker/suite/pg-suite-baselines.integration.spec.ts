import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { BASELINE_KEEP_COMMITS, BASELINE_KEEP_DAYS, PgSuiteBaselines, type BaselineRecord } from './pg-suite-baselines';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_baselines');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const DAY = 86_400_000;
const NOW = new Date('2026-11-23T12:00:00.000Z');

const baseline = (n: number, over: Partial<BaselineRecord> = {}): BaselineRecord => ({
    organizationId: 'org-a',
    environmentId: 'env-1',
    mainSha: sha(n),
    suiteDigest: 'sha256:d1',
    status: 'complete',
    specs: { 'a.cy.ts': { status: 'passed', durationMs: 1_000 } },
    finishedAt: new Date(NOW.getTime() - (100 - n) * 60_000),
    ...over,
});

(skip ? describe.skip : describe)('runtime_suite_baselines (real Postgres)', () => {
    let pool: Pool;
    let store: PgSuiteBaselines;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgSuiteBaselines(pool, () => NOW);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_baselines');
    });

    const rows = async () => (await pool.query('SELECT main_sha, status FROM runtime.runtime_suite_baselines ORDER BY main_sha')).rows;

    it('one baseline per environment, main commit and suite digest: a second complete one for the same key changes nothing', async () => {
        expect(await store.record(baseline(1))).toEqual({ stored: true });
        expect(await store.record(baseline(1, { specs: { 'a.cy.ts': { status: 'failed', durationMs: 1, errorSignature: 'x' } } }))).toEqual({ stored: false });
        expect((await store.find('org-a', 'env-1', sha(1), 'sha256:d1'))!.specs['a.cy.ts'].status).toBe('passed');
        // Another digest of the same commit is another baseline: a changed suite never reuses an old one.
        expect(await store.record(baseline(1, { suiteDigest: 'sha256:d2' }))).toEqual({ stored: true });
        expect(await rows()).toHaveLength(2);
    });

    it('an incomplete baseline (an infra failure) is not a baseline: lookups skip it and a complete run of the same key replaces it', async () => {
        await store.record(baseline(1, { status: 'incomplete', specs: {} }));
        expect(await store.find('org-a', 'env-1', sha(1), 'sha256:d1')).toBeNull();
        expect(await store.record(baseline(1))).toEqual({ stored: true });
        expect(await rows()).toEqual([{ main_sha: sha(1), status: 'complete' }]);
        expect(await store.find('org-a', 'env-1', sha(1), 'sha256:d1')).not.toBeNull();
    });

    it('finds the nearest ancestor that has a complete baseline, in the order the commits are given', async () => {
        await store.record(baseline(2));
        await store.record(baseline(4));
        await store.record(baseline(3, { status: 'incomplete', specs: {} }));
        const found = await store.findAmong('org-a', 'env-1', 'sha256:d1', [sha(5), sha(3), sha(2), sha(1)]);
        expect(found?.mainSha).toBe(sha(2));
        expect(await store.findAmong('org-a', 'env-1', 'sha256:d1', [sha(9)])).toBeNull();
        expect(await store.findAmong('org-b', 'env-1', 'sha256:d1', [sha(2)])).toBeNull();
    });

    it(`keeps the newest ${BASELINE_KEEP_COMMITS} commits of an environment and removes the older ones`, async () => {
        for (let n = 1; n <= BASELINE_KEEP_COMMITS + 5; n++) await store.record(baseline(n, { finishedAt: new Date(NOW.getTime() - (BASELINE_KEEP_COMMITS + 6 - n) * 60_000) }));
        const kept = await rows();
        expect(kept).toHaveLength(BASELINE_KEEP_COMMITS);
        expect(kept.map((r) => r.main_sha)).not.toContain(sha(1));
        expect(kept.map((r) => r.main_sha)).toContain(sha(BASELINE_KEEP_COMMITS + 5));
        // Another environment's rows are never counted.
        await store.record(baseline(1, { environmentId: 'env-2' }));
        expect((await pool.query(`SELECT 1 FROM runtime.runtime_suite_baselines WHERE environment_id = 'env-2'`)).rowCount).toBe(1);
    });

    it(`removes what is older than ${BASELINE_KEEP_DAYS} days but never the newest complete baseline of the environment, however old`, async () => {
        const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
        await store.record(baseline(1, { finishedAt: ago(60) }));
        await store.record(baseline(2, { finishedAt: ago(45) }));
        await store.record(baseline(3, { finishedAt: ago(40), status: 'incomplete', specs: {} }));
        // Every one of these was old at the time it was written; the pass that wrote the last one pruned the environment.
        await store.record(baseline(4, { status: 'incomplete', specs: {} }));
        expect((await rows()).map((r) => r.main_sha)).toEqual([sha(2), sha(4)]);
    });
});
