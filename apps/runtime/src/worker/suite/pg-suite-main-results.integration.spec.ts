import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { HISTORY_KEEP, type MainObservationRow, PgSuiteMainResults } from './pg-suite-main-results';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_main_results');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const ORG = 'org-a';
const ENV = 'env-1';
const NOW = new Date('2026-11-27T10:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const row = (spec: string, status: 'passed' | 'failed', sig?: string): MainObservationRow => ({ spec, status, ...(sig ? { errorSignature: sig } : {}), tests: [{ title: `${spec} works`, status, ...(sig ? { errorSignature: sig } : {}) }] });

(skip ? describe.skip : describe)('runtime_suite_main_observations (real Postgres)', () => {
    let pool: Pool;
    let store: PgSuiteMainResults;
    const rec = (runId: string, sha: string, digest: string, source: 'baseline' | 'rerun', min: number, rows: MainObservationRow[], org = ORG) =>
        store.record({ organizationId: org, environmentId: ENV, suiteRunId: runId, mainSha: sha, suiteDigest: digest, source, observedAt: at(min), rows });

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 3 });
        await ensureRuntimeSchema(pool);
        store = new PgSuiteMainResults(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_main_observations');
    });

    // A result is reused only for the same suite digest: a changed suite never reuses an old main result.
    it('answers a stored result only for the same environment, commit, spec and suite digest', async () => {
        await rec('r1', 'sha1', 'd1', 'baseline', 0, [row('a', 'passed'), row('b', 'failed', 'boom')]);
        const hit = await store.at(ORG, ENV, 'd1', ['sha1'], ['a', 'b', 'c']);
        expect([...hit.keys()].sort()).toEqual(['a', 'b']);
        expect(hit.get('b')!.observations[0]).toMatchObject({ status: 'failed', errorSignature: 'boom', tests: [{ title: 'b works', status: 'failed' }] });
        expect((await store.at(ORG, ENV, 'd2', ['sha1'], ['a'])).size).toBe(0);
        expect((await store.at(ORG, ENV, 'd1', ['other'], ['a'])).size).toBe(0);
        expect((await store.at('org-b', ENV, 'd1', ['sha1'], ['a'])).size).toBe(0);
    });

    // The merge base is preferred; a spec with no result there takes the next commit that has one.
    it('takes the first commit of the list that has a result for each spec', async () => {
        await rec('r1', 'mainHead', 'd1', 'baseline', 0, [row('a', 'passed'), row('b', 'passed')]);
        await rec('r2', 'mergeBase', 'd1', 'rerun', 1, [row('a', 'failed', 'boom')]);
        const hit = await store.at(ORG, ENV, 'd1', ['mergeBase', 'mainHead'], ['a', 'b']);
        expect(hit.get('a')!.mainSha).toBe('mergeBase');
        expect(hit.get('b')!.mainSha).toBe('mainHead');
    });

    // One commit can hold both outcomes: both are kept, and the history says they differ.
    it('keeps a pass and a fail of one commit side by side', async () => {
        await rec('r1', 'sha1', 'd1', 'baseline', 0, [row('a', 'passed')]);
        await rec('r2', 'sha1', 'd1', 'rerun', 5, [row('a', 'failed', 'boom')]);
        expect((await store.at(ORG, ENV, 'd1', ['sha1'], ['a'])).get('a')!.observations.map((o) => o.status)).toEqual(['passed', 'failed']);
    });

    // A run recorded twice (a replayed step) counts once.
    it('records a run once whatever the redelivery', async () => {
        await rec('r1', 'sha1', 'd1', 'baseline', 0, [row('a', 'passed')]);
        await rec('r1', 'sha1', 'd1', 'baseline', 1, [row('a', 'passed')]);
        expect((await store.history(ORG, ENV, ['a'])).get('a')).toHaveLength(1);
    });

    // The history is the spec's newest runs on main whatever the digest, newest first, so adding a spec does not reset anyone's record.
    it('gives the newest runs of a spec across suite digests', async () => {
        await rec('r1', 's1', 'd1', 'baseline', 0, [row('a', 'failed', 'boom')]);
        await rec('r2', 's2', 'd2', 'baseline', 10, [row('a', 'passed')]);
        expect((await store.history(ORG, ENV, ['a'])).get('a')!.map((o) => [o.mainSha, o.status])).toEqual([['s2', 'passed'], ['s1', 'failed']]);
    });

    // Each spec keeps its newest HISTORY_KEEP runs; the rest are dropped on record.
    it('keeps only the newest runs of a spec', async () => {
        for (let i = 0; i < HISTORY_KEEP + 5; i++) await rec(`r${i}`, `s${i}`, 'd1', 'baseline', i, [row('a', 'passed')]);
        expect((await store.history(ORG, ENV, ['a'])).get('a')!.length).toBeLessThanOrEqual(20);
        const n = await pool.query(`SELECT count(*)::int AS n FROM runtime.runtime_suite_main_observations`);
        expect(n.rows[0].n).toBe(HISTORY_KEEP);
    });
});
