import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import type { RuntimeSuitePublishRequested } from '@libs/runtime/run';

import { InMemorySuiteRuns } from './testing';
import { SuitePublisher } from './suite-publisher';

// docs/runtime/e2e-suites.md section 10.1: the Runtime asks the product to publish the suite's check, with structured fields
// read from what the run stored: opened when the suite starts, closed with the conclusion and the annotations.

const ORG = 'org-a';
const ID = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const cmd = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({ suiteRunId: ID, organizationId: ORG, environmentId: 'env-1', repositoryId: 'repo-1', mode: 'ci', prNumber: 7, prSha: B, mergeBase: A, mainSha: A, requestedAt: '2026-11-23T12:00:00.000Z', key: ID, ...over });

async function world(over: { classification?: any; results?: any[]; state?: any; selection?: any; mode?: 'run' | 'ci' } = {}) {
    const runs = new InMemorySuiteRuns();
    const sent: RuntimeSuitePublishRequested[] = [];
    const publisher = new SuitePublisher(runs, { request: async (m) => void sent.push(m) });
    await runs.create({ suiteRunId: ID, organizationId: ORG, environmentId: 'env-1', repositoryId: 'repo-1', mode: over.mode ?? 'ci', prNumber: 7, prSha: B, mergeBase: A, mainSha: A, requestedAt: new Date('2026-11-23T12:00:00.000Z'), ...(over.selection ? { selection: over.selection } : {}) });
    if (over.results) await runs.recordResults(ORG, ID, { phase: 'shard', shard: 0 }, over.results);
    await runs.finish(ORG, ID, over.state ?? 'failed', new Date('2026-11-23T12:20:00.000Z'), { ...(over.classification ? { classification: over.classification } : {}), baselineSha: A, baseDrift: 2 });
    return { runs, sent, publisher };
}
const failing = { spec: 'a.cy.ts', status: 'failed' as const, durationMs: 5, tests: [{ title: 'works', status: 'failed', attempts: [{ status: 'failed', ms: 5, error: 'boom\n    at Context.eval (a.cy.ts:9:3)' }] }] };
const classification = { tests: [{ spec: 'a.cy.ts', title: 'works', class: 'regression', blocks: true, finding: true, baseDrift: 2 }], massFailure: false, requestTemplateBuild: false };

describe('publishing the suite check', () => {
    it('opens the check when the suite starts: in progress, no conclusion, the key of the running phase', async () => {
        const runs = new InMemorySuiteRuns();
        const sent: RuntimeSuitePublishRequested[] = [];
        await new SuitePublisher(runs, { request: async (m) => void sent.push(m) }).started(cmd());
        expect(sent).toEqual([expect.objectContaining({ suiteRunId: ID, targetId: ID, attempt: 1, key: `${ID}:suite:check:running`, check: { status: 'in_progress' }, report: expect.objectContaining({ state: 'running', mode: 'ci', mainSha: A, prSha: B }) })]);
    });

    it('closes it with what the run stored: the conclusion of its state, the classes, the annotation with the failing line, the baseline and the drift', async () => {
        const w = await world({ results: [failing], classification, selection: { mode: 'full', reason: 'map_missing', total: 1 } });
        await w.publisher.finished(cmd(), { status: 'ran', suiteRunId: ID, state: 'failed', replayed: false }, { cwd: 'apps/dashboard' });
        const [m] = w.sent;
        expect(m).toMatchObject({ key: `${ID}:suite:check`, check: { status: 'completed', conclusion: 'failure' } });
        expect(m.report).toMatchObject({
            state: 'failed', baseline: { sha: A }, baseDrift: 2, selection: { mode: 'full', reason: 'map_missing', total: 1 },
            totals: { failed: 1 }, classes: { regression: 1 }, annotations: [{ path: 'apps/dashboard/a.cy.ts', line: 9, level: 'failure', title: 'works' }],
        });
    });

    it('a run that never said how it chose reports the whole suite, with no reason it cannot prove', async () => {
        const w = await world({ results: [{ ...failing, status: 'passed' }], state: 'passed' });
        await w.publisher.finished(cmd(), { status: 'ran', suiteRunId: ID, state: 'passed', replayed: false }, {});
        expect(w.sent[0].report.selection).toEqual({ mode: 'full', total: 1 });
        expect(w.sent[0].check).toEqual({ status: 'completed', conclusion: 'success' });
    });

    it('a run that could not start closes neutral and says why', async () => {
        const w = await world({ state: 'neutral' });
        await w.publisher.finished(cmd(), { status: 'unavailable', suiteRunId: ID, state: 'neutral', reason: 'template_missing' }, {});
        expect(w.sent[0]).toMatchObject({ check: { status: 'completed', conclusion: 'neutral' }, report: { state: 'neutral', unavailable: 'template_missing' } });
    });

    it('publishes nothing for a baseline, which has no PR, and nothing for an environment with no suite', async () => {
        const w = await world();
        await w.publisher.started(cmd({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }));
        await w.publisher.finished(cmd({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), { status: 'ran', suiteRunId: ID, state: 'passed', replayed: false }, {});
        await w.publisher.started(cmd());
        w.sent.length = 0;
        await w.publisher.finished(cmd(), { status: 'off', reason: 'no_suite' }, {});
        expect(w.sent).toEqual([]);
    });

    it('names the target the product stored: the Run in Run mode, the suite run otherwise', async () => {
        const w = await world({ results: [failing], classification, mode: 'run' });
        await w.publisher.finished(cmd({ mode: 'run', targetId: 'run-77' }), { status: 'ran', suiteRunId: ID, state: 'failed', replayed: false }, {});
        expect(w.sent[0]).toMatchObject({ targetId: 'run-77', report: { mode: 'run' } });
    });
});
