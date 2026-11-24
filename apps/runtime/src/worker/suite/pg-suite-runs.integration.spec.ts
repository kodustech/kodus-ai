import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgSuiteRuns, type SuiteRunRecord } from './pg-suite-runs';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_runs');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const run: SuiteRunRecord = {
    suiteRunId: '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11',
    organizationId: 'org-a',
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    mode: 'ci',
    prNumber: 7,
    prSha: 'a'.repeat(40),
    mergeBase: 'b'.repeat(40),
    mainSha: 'b'.repeat(40),
    requestedAt: new Date('2026-11-23T12:00:00.000Z'),
};

(skip ? describe.skip : describe)('the suite run, shard and result tables (real Postgres)', () => {
    let pool: Pool;
    let store: PgSuiteRuns;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
        await ensureRuntimeSchema(pool);
        store = new PgSuiteRuns(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        for (const t of ['runtime_suite_results', 'runtime_suite_shards', 'runtime_suite_runs']) await pool.query(`DELETE FROM runtime.${t}`);
    });

    it('a request delivered twice creates one run: the second finds it', async () => {
        expect(await store.create(run)).toEqual({ created: true });
        expect(await store.create(run)).toEqual({ created: false });
        expect((await store.get('org-a', run.suiteRunId))!.state).toBe('requested');
        // Another organization never sees it.
        expect(await store.get('org-b', run.suiteRunId)).toBeNull();
    });

    it('stores the plan once per shard, and a replan of the same shard replaces its specs', async () => {
        await store.create(run);
        await store.savePlan('org-a', run.suiteRunId, [{ shard: 0, specs: ['a.cy.ts', 'b.cy.ts'] }, { shard: 1, specs: ['c.cy.ts'] }]);
        await store.savePlan('org-a', run.suiteRunId, [{ shard: 1, specs: ['c.cy.ts', 'd.cy.ts'] }]);
        expect(await store.shards('org-a', run.suiteRunId)).toEqual([
            { shard: 0, state: 'planned', specs: ['a.cy.ts', 'b.cy.ts'] },
            { shard: 1, state: 'planned', specs: ['c.cy.ts', 'd.cy.ts'] },
        ]);
    });

    it('keeps one result per spec and phase however often a shard reports it, and a rerun is its own phase', async () => {
        await store.create(run);
        const failed = { spec: 'a.cy.ts', status: 'failed' as const, durationMs: 900, errorSignature: 'timeout', tests: [] };
        await store.recordResults('org-a', run.suiteRunId, { phase: 'shard', shard: 0 }, [failed]);
        await store.recordResults('org-a', run.suiteRunId, { phase: 'shard', shard: 0 }, [failed, { spec: 'b.cy.ts', status: 'passed', durationMs: 100, tests: [] }]);
        await store.recordResults('org-a', run.suiteRunId, { phase: 'rerun_pr', shard: 0 }, [{ ...failed, status: 'passed', errorSignature: undefined }]);
        const got = await store.results('org-a', run.suiteRunId);
        expect(got.map((r) => `${r.phase}:${r.spec}:${r.status}`)).toEqual(['rerun_pr:a.cy.ts:passed', 'shard:a.cy.ts:failed', 'shard:b.cy.ts:passed']);
        expect(got.find((r) => r.phase === 'shard' && r.spec === 'a.cy.ts')!.errorSignature).toBe('timeout');
        expect(await store.results('org-b', run.suiteRunId)).toEqual([]);
    });

    it('keeps the artifacts of a failed spec beside its result, only for the row of that phase, and reads them back', async () => {
        await store.create(run);
        const failed = { spec: 'a.cy.ts', status: 'failed' as const, durationMs: 900, tests: [] };
        await store.recordResults('org-a', run.suiteRunId, { phase: 'shard', shard: 0 }, [failed, { spec: 'b.cy.ts', status: 'passed', durationMs: 100, tests: [] }]);
        const artifacts = [{ name: 'cypress/screenshots/a.cy.ts/fail.png', key: 'org-a/run/pr/step/suite-artifact', contentType: 'image/png', bytes: 42 }];
        await store.recordArtifacts('org-a', run.suiteRunId, { phase: 'shard', shard: 0 }, [{ spec: 'a.cy.ts', artifacts }, { spec: 'gone.cy.ts', artifacts }]);
        // Another organization's id changes nothing.
        await store.recordArtifacts('org-b', run.suiteRunId, { phase: 'shard', shard: 0 }, [{ spec: 'b.cy.ts', artifacts }]);
        const got = await store.results('org-a', run.suiteRunId);
        expect(got.find((r) => r.spec === 'a.cy.ts')?.artifacts).toEqual(artifacts);
        expect(got.find((r) => r.spec === 'b.cy.ts')?.artifacts).toBeUndefined();
        // Reporting the spec again keeps what was kept for it.
        await store.recordResults('org-a', run.suiteRunId, { phase: 'shard', shard: 0 }, [failed]);
        expect((await store.results('org-a', run.suiteRunId)).find((r) => r.spec === 'a.cy.ts')?.artifacts).toEqual(artifacts);
    });

    it('ends a run once: the first conclusion stays', async () => {
        await store.create(run);
        await store.finish('org-a', run.suiteRunId, 'passed', new Date('2026-11-23T12:20:00.000Z'));
        await store.finish('org-a', run.suiteRunId, 'failed', new Date('2026-11-23T12:30:00.000Z'));
        const r = (await store.get('org-a', run.suiteRunId))!;
        expect(r.state).toBe('passed');
        expect(r.finishedAt?.toISOString()).toBe('2026-11-23T12:20:00.000Z');
    });

    it('answers the latest earlier run of a PR for the re-push rule', async () => {
        await store.create(run);
        await store.create({ ...run, suiteRunId: '1c5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c12', prSha: 'c'.repeat(40), requestedAt: new Date('2026-11-23T13:00:00.000Z') });
        await store.create({ ...run, suiteRunId: '2c5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c13', prNumber: 8, requestedAt: new Date('2026-11-23T14:00:00.000Z') });
        expect((await store.latestForPr('org-a', 'env-1', 7))!.prSha).toBe('c'.repeat(40));
        expect(await store.latestForPr('org-a', 'env-1', 99)).toBeNull();
        // From before a run: the run never reads itself as its previous.
        expect((await store.latestForPr('org-a', 'env-1', 7, new Date('2026-11-23T13:00:00.000Z')))!.prSha).toBe('a'.repeat(40));
        expect(await store.latestForPr('org-a', 'env-1', 7, new Date('2026-11-23T12:00:00.000Z'))).toBeNull();
    });

    it('keeps the classification a finished run ends with, and the first conclusion stays', async () => {
        await store.create(run);
        const classification = { tests: [{ spec: 'a.cy.ts', title: 't', class: 'regression', blocks: true, finding: true, baseDrift: 0 }], massFailure: false, requestTemplateBuild: false };
        await store.finish('org-a', run.suiteRunId, 'failed', new Date('2026-11-23T12:30:00.000Z'), { classification: classification as never });
        await store.finish('org-a', run.suiteRunId, 'passed', new Date('2026-11-23T12:40:00.000Z'), { classification: undefined });
        const stored = await store.get('org-a', run.suiteRunId);
        expect(stored?.state).toBe('failed');
        expect(stored?.classification).toEqual(classification);
    });

    it('keeps how the specs were chosen from the start, and the baseline and the drift the run was judged with at its end', async () => {
        const selection = { mode: 'full', reason: 'map_missing', total: 12 } as const;
        await store.create({ ...run, selection });
        expect((await store.get('org-a', run.suiteRunId))?.selection).toEqual(selection);
        await store.finish('org-a', run.suiteRunId, 'passed', new Date('2026-11-23T12:30:00.000Z'), { baselineSha: 'c'.repeat(40), baseDrift: 3 });
        const stored = await store.get('org-a', run.suiteRunId);
        expect(stored).toMatchObject({ baselineSha: 'c'.repeat(40), baseDrift: 3 });
        // A run that never said how it chose has no selection to report.
        await store.create({ ...run, suiteRunId: '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c12' });
        expect((await store.get('org-a', '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c12'))?.selection).toBeUndefined();
    });

    it('lists the live runs of one PR in one repository of one organization, except those of the head it keeps, and never a baseline or a finished run', async () => {
        const other = (suiteRunId: string, over: Partial<SuiteRunRecord>) => store.create({ ...run, suiteRunId, ...over });
        await other('r-old', { prSha: 'a'.repeat(40) });
        await other('r-new', { prSha: 'c'.repeat(40) });
        await other('r-done', { prSha: 'd'.repeat(40) });
        await store.finish('org-a', 'r-done', 'passed', new Date());
        await other('r-baseline', { mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined });
        await other('r-pr8', { prNumber: 8 });
        await other('r-repo2', { repositoryId: 'repo-2' });
        await other('r-org-b', { organizationId: 'org-b' });
        const ids = async (keep?: string) => (await store.livePullRequestRuns('org-a', 'repo-1', 7, keep)).map((r) => r.suiteRunId).sort();
        expect(await ids('c'.repeat(40))).toEqual(['r-old']);
        // A closed PR keeps nothing.
        expect(await ids()).toEqual(['r-new', 'r-old']);
    });
});
