import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import type { CoverageMapRecord } from './coverage-collector';
import { MAP_KEEP_COMPLETE, PgSuiteCoverageMaps } from './pg-suite-coverage-maps';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_coverage_maps');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const NOW = new Date('2026-11-23T12:00:00.000Z');

const map = (n: number, over: Partial<CoverageMapRecord> = {}): CoverageMapRecord => ({
    organizationId: 'org-a',
    environmentId: 'env-1',
    mainSha: sha(n),
    suiteDigest: 'sha256:d1',
    status: 'complete',
    specs: { 'a.cy.ts': ['src/a.ts'], 'api.cy.ts': ['server/api.ts'] },
    finishedAt: new Date(NOW.getTime() - (100 - n) * 60_000),
    ...over,
});

(skip ? describe.skip : describe)('runtime_suite_coverage_maps (real Postgres)', () => {
    let pool: Pool;
    let store: PgSuiteCoverageMaps;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgSuiteCoverageMaps(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_coverage_maps');
    });

    const rows = async () => (await pool.query('SELECT main_sha, suite_digest, status FROM runtime.runtime_suite_coverage_maps ORDER BY main_sha, suite_digest')).rows;

    it('one map per environment, main commit and suite digest: a second complete one for the same key changes nothing', async () => {
        expect(await store.record(map(1))).toEqual({ stored: true });
        expect(await store.record(map(1, { specs: { 'a.cy.ts': ['src/other.ts'] } }))).toEqual({ stored: false });
        expect((await store.newest('org-a', 'env-1'))?.specs['a.cy.ts']).toEqual(['src/a.ts']);
    });

    it('a changed suite (another digest) of the same commit is another map, and the newest one answers: the old digest is not reused as the new', async () => {
        await store.record(map(1, { suiteDigest: 'sha256:old', finishedAt: new Date(NOW.getTime() - 60_000) }));
        await store.record(map(1, { suiteDigest: 'sha256:new', finishedAt: NOW }));
        expect(await rows()).toHaveLength(2);
        expect((await store.newest('org-a', 'env-1'))?.suiteDigest).toBe('sha256:new');
    });

    it('an incomplete map is no map: newest skips it, and a complete run of the same key replaces it', async () => {
        await store.record(map(1, { status: 'incomplete', specs: { 'a.cy.ts': ['src/a.ts'] } }));
        expect(await store.newest('org-a', 'env-1')).toBeUndefined();
        expect(await store.record(map(1))).toEqual({ stored: true });
        expect((await store.newest('org-a', 'env-1'))?.mainSha).toBe(sha(1));
    });

    it(`keeps the newest complete map and the one before (${MAP_KEEP_COMPLETE}) and removes the older ones`, async () => {
        for (const n of [1, 2, 3, 4]) await store.record(map(n));
        expect((await rows()).map((r) => r.main_sha)).toEqual([sha(3), sha(4)]);
        expect((await store.newest('org-a', 'env-1'))?.mainSha).toBe(sha(4));
    });

    it('an incomplete map newer than the newest complete one stays until replaced; an older one goes', async () => {
        await store.record(map(1));
        await store.record(map(2, { status: 'incomplete', specs: {} }));
        await store.record(map(3));
        await store.record(map(4, { status: 'incomplete', specs: {} }));
        expect(await rows()).toEqual([
            { main_sha: sha(1), suite_digest: 'sha256:d1', status: 'complete' },
            { main_sha: sha(3), suite_digest: 'sha256:d1', status: 'complete' },
            { main_sha: sha(4), suite_digest: 'sha256:d1', status: 'incomplete' },
        ]);
    });

    it('never reads or prunes another environment or organization', async () => {
        await store.record(map(1));
        await store.record(map(1, { environmentId: 'env-2' }));
        for (const n of [2, 3, 4]) await store.record(map(n));
        expect((await pool.query(`SELECT 1 FROM runtime.runtime_suite_coverage_maps WHERE environment_id = 'env-2'`)).rowCount).toBe(1);
        expect(await store.newest('org-b', 'env-1')).toBeUndefined();
    });
});
