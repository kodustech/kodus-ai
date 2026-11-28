import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';
import { ensureRuntimeSchema } from './runtime-schema';
import { PgSuiteBaselineRequests } from './suite-baseline-requests';

// docs/runtime/e2e-suites.md section 2.1, step 5: at most one baseline queued per environment; a newer main commit
// replaces a queued one that has not started, and a started one finishes. Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_baseline_requests');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const sha = (c: string) => c.repeat(40);
const ask = (over: Partial<Parameters<PgSuiteBaselineRequests['request']>[0]> = {}) => ({ organizationId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', mainSha: sha('a'), fingerprint: 'f'.repeat(64), ...over });

(skip ? describe.skip : describe)('the baselines a template turning ready asks for (real Postgres)', () => {
    let pool: Pool;
    let requests: PgSuiteBaselineRequests;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        requests = new PgSuiteBaselineRequests(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM runtime.runtime_suite_baseline_requests');
    });

    it('records a queued request with the id its suite run will have, which a repeat of the same commit keeps', async () => {
        await requests.request(ask());
        await requests.request(ask());
        const pending = await requests.pending(10);
        expect(pending).toEqual([expect.objectContaining({ organizationId: 'org-a', environmentId: 'env-1', repositoryId: 'repo-1', mainSha: sha('a'), suiteRunId: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
        const first = pending[0].suiteRunId;
        await requests.request(ask());
        expect((await requests.pending(10))[0].suiteRunId).toBe(first);
    });

    it('a newer main commit replaces the one still queued for the environment, and another environment is left alone', async () => {
        await requests.request(ask({ mainSha: sha('a') }));
        await requests.request(ask({ environmentId: 'env-2', mainSha: sha('c') }));
        await requests.request(ask({ mainSha: sha('b') }));
        expect((await requests.pending(10)).map((r) => `${r.environmentId}:${r.mainSha[0]}`).sort()).toEqual(['env-1:b', 'env-2:c']);
    });

    it('a newer main commit leaves the replaced request in the table as superseded, with that reason, instead of deleting it', async () => {
        await requests.request(ask({ mainSha: sha('a') }));
        await requests.request(ask({ mainSha: sha('b') }));
        const rows = (await pool.query(`SELECT main_sha, state, reason FROM runtime.runtime_suite_baseline_requests ORDER BY main_sha`)).rows.map((r) => `${r.main_sha[0]}:${r.state}:${r.reason}`);
        expect(rows).toEqual(['a:superseded:superseded', 'b:queued:null']);
    });

    it('a request the product skipped leaves the queue with its reason, and only the organization\'s own queued request moves', async () => {
        await requests.request(ask());
        await requests.markSkipped('org-b', 'env-1', sha('a'), 'no_suite');
        expect(await requests.pending(10)).toHaveLength(1);
        await requests.markSkipped('org-a', 'env-1', sha('a'), 'no_suite');
        expect(await requests.pending(10)).toEqual([]);
        expect((await pool.query(`SELECT state, reason FROM runtime.runtime_suite_baseline_requests`)).rows).toEqual([{ state: 'skipped', reason: 'no_suite' }]);
        // A repeat of the command, or one for a request that started, changes nothing.
        await requests.request(ask({ mainSha: sha('b') }));
        await requests.markStarted('org-a', 'env-1', sha('b'));
        await requests.markSkipped('org-a', 'env-1', sha('b'), 'no_suite');
        expect((await pool.query(`SELECT main_sha, state FROM runtime.runtime_suite_baseline_requests ORDER BY main_sha`)).rows.map((r) => `${r.main_sha[0]}:${r.state}`)).toEqual(['a:skipped', 'b:started']);
    });

    it('a started baseline finishes: the next commit queues beside it, and the started one is no longer pending', async () => {
        await requests.request(ask({ mainSha: sha('a') }));
        await requests.markStarted('org-a', 'env-1', sha('a'));
        await requests.request(ask({ mainSha: sha('b') }));
        expect((await requests.pending(10)).map((r) => r.mainSha[0])).toEqual(['b']);
        const states = (await pool.query(`SELECT main_sha, state FROM runtime.runtime_suite_baseline_requests ORDER BY main_sha`)).rows.map((r) => `${r.main_sha[0]}:${r.state}`);
        expect(states).toEqual(['a:started', 'b:queued']);
        // The commit that is started is not asked for again.
        await requests.request(ask({ mainSha: sha('a') }));
        expect((await requests.pending(10)).map((r) => r.mainSha[0])).toEqual(['b']);
    });

    // The worker found main needs no full run for this commit: the request it already started ends skipped as lazy, for its own organization only.
    it('a started request the worker found lazy ends skipped with the reason lazy, for its own organization only', async () => {
        await requests.request(ask());
        await requests.markStarted('org-a', 'env-1', sha('a'));
        await requests.markLazy('org-b', 'env-1', sha('a'));
        expect((await pool.query(`SELECT state, reason FROM runtime.runtime_suite_baseline_requests`)).rows).toEqual([{ state: 'started', reason: null }]);
        await requests.markLazy('org-a', 'env-1', sha('a'));
        expect((await pool.query(`SELECT state, reason FROM runtime.runtime_suite_baseline_requests`)).rows).toEqual([{ state: 'skipped', reason: 'lazy' }]);
    });

    it("another organization's mark does not start the request, and the oldest request is listed first", async () => {
        await requests.request(ask({ environmentId: 'env-1' }));
        await requests.request(ask({ environmentId: 'env-2', mainSha: sha('b') }));
        await requests.markStarted('org-b', 'env-1', sha('a'));
        expect((await requests.pending(10)).map((r) => r.environmentId)).toEqual(['env-1', 'env-2']);
        expect(await requests.pending(1)).toHaveLength(1);
    });
});
