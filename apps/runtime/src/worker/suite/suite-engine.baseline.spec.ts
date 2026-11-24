import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { suiteDigestOf } from '@libs/runtime/suite';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteBaselines, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine, type SuiteEngineDeps, type SuiteInputs } from './suite-engine';

// docs/runtime/e2e-suites.md sections 2.1, 7.1, 8 and 9.5: the baseline is the whole suite on one main commit, stored
// per (environment, main sha, suite digest); a PR run uses it as evidence, never in place of the re-run on main unless
// it says the same thing the PR does.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const ERR = 'expected 3 got 4';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 1 };
const sha = (c: string) => c.repeat(40);
const MAIN = sha('a');
// Ten passing specs: two red ones stay under the 25% that would make it the environment (9.4).
const oks = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i + 1}.cy.ts`, {}]));
const prRequest = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'ci', prNumber: 7, prSha: sha('b'), mergeBase: MAIN, mainSha: MAIN, requestedAt: '2026-11-23T12:00:00.000Z', key: 'sr-1', ...over,
});
const baselineRequest = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-b', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'baseline', mainSha: MAIN, requestedAt: '2026-11-23T12:00:00.000Z', key: 'sr-b', ...over,
});

function world(scenario: FakeSuiteWorld, over: { deps?: Partial<SuiteEngineDeps>; inputs?: Partial<SuiteInputs> } = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, scenario);
    const baselines = new InMemorySuiteBaselines();
    const runs = new InMemorySuiteRuns(clock);
    const engine = new SuiteEngine({ env: cell, runs, stats: new InMemorySuiteSpecStats(), demand: new FakeSuiteDemand(clock), clock, baselines, ...over.deps });
    const specs = Object.keys(scenario.specs);
    const inputs = (extra: Partial<SuiteInputs> = {}): SuiteInputs => ({ config, specs: specs.map((path) => ({ path, sizeBytes: 100 })), ...over.inputs, ...extra });
    const digest = suiteDigestOf(config, specs);
    return { cell, baselines, engine, digest, inputs, runs };
}
const classOf = (o: { classification?: { tests: Array<{ spec: string; class: string }> } }) => Object.fromEntries((o.classification?.tests ?? []).map((t) => [t.spec, t.class]));
const history = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? MAIN : sha((i + 9).toString(16).slice(-1)) .slice(0, 38) + String(i).padStart(2, '0')));

describe('the baseline of a main commit', () => {
    it('stores every spec of main as it ended, per main sha and suite digest, and a red spec is a result, not a re-run', async () => {
        const w = world({ specs: { ...oks, 'red.cy.ts': { main: [{ fail: ERR }] } } });
        await w.engine.run(baselineRequest(), w.inputs());
        const b = await w.baselines.find(ORG, ENV, MAIN, w.digest);
        expect(b).toMatchObject({ status: 'complete', mainSha: MAIN, suiteDigest: w.digest });
        expect(b?.specs['o1.cy.ts']).toMatchObject({ status: 'passed', durationMs: 20_000 });
        expect(b?.specs['red.cy.ts']).toMatchObject({ status: 'failed', errorSignature: 'expected <n> got <n>' });
        expect(w.cell.starts).toHaveLength(1);
    });

    it('is incomplete when a spec never ran, and an incomplete baseline is no baseline for any lookup', async () => {
        const w = world({ specs: { ...oks, 'slow.cy.ts': { ms: 90 * MIN } } });
        await w.engine.run(baselineRequest(), w.inputs());
        expect(await w.baselines.find(ORG, ENV, MAIN, w.digest)).toBeNull();
        expect([...w.baselines.rows.values()]).toEqual([expect.objectContaining({ status: 'incomplete' })]);
    });
});

describe('a PR run with a baseline', () => {
    const seed = (w: ReturnType<typeof world>, over: { sha?: string; specs?: Record<string, { status: 'passed' | 'failed'; durationMs: number; errorSignature?: string }>; digest?: string } = {}) =>
        w.baselines.record({ organizationId: ORG, environmentId: ENV, mainSha: over.sha ?? MAIN, suiteDigest: over.digest ?? w.digest, status: 'complete', specs: over.specs ?? {}, finishedAt: new Date() });
    const SIG = 'expected <n> got <n>';

    it('a spec red in the merge base with the same error is pre-existing, and main is not run for it', async () => {
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }] } } });
        await seed(w, { specs: { 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: SIG } } });
        const out = await w.engine.run(prRequest(), w.inputs({ mainHistory: [MAIN] }));
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'pre_existing' });
        expect(out.state).toBe('passed');
        expect(w.cell.acquires.filter((a) => a.ref.side === 'base')).toEqual([]);
    });

    it('goes to main only for the specs the baseline does not already explain', async () => {
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }] }, 'new.cy.ts': { pr: [{ fail: ERR }] } } });
        await seed(w, { specs: { 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: SIG } } });
        const out = await w.engine.run(prRequest(), w.inputs({ mainHistory: [MAIN] }));
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'pre_existing', 'new.cy.ts': 'regression' });
        const onMain = w.cell.starts.filter((s) => w.cell.claims.get(s.claimId)?.side === 'base');
        expect(onMain.map((s) => s.specs)).toEqual([['new.cy.ts']]);
    });

    it("the baseline of an older main commit is history: main is still re-run, since main today may differ", async () => {
        const hist = history(4);
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }] } } });
        await seed(w, { sha: hist[3], specs: { 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: SIG } } });
        const out = await w.engine.run(prRequest({ mergeBase: hist[2] }), w.inputs({ mainHistory: hist }));
        expect(w.cell.acquires.filter((a) => a.ref.side === 'base')).toHaveLength(1);
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'regression_unconfirmed' });
    });

    it('with no main host, a spec that passed in the merge base is a probable regression and one that failed there is pre-existing', async () => {
        const w = world({ specs: { ...oks, 'good.cy.ts': { pr: [{ fail: ERR }] }, 'old.cy.ts': { pr: [{ fail: ERR }] } }, blocked: (r) => r.shard === 63 });
        await seed(w, { specs: { 'good.cy.ts': { status: 'passed', durationMs: 1 }, 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: 'another error' } } });
        const out = await w.engine.run(prRequest(), w.inputs({ mainHistory: [MAIN] }));
        expect(classOf(out)).toEqual({ 'good.cy.ts': 'regression_probable', 'old.cy.ts': 'pre_existing' });
        expect(out.classification?.tests.every((t) => !t.finding)).toBe(true);
        expect(out.state).toBe('neutral');
    });

    it('a baseline more than 20 main commits behind is not evidence', async () => {
        const hist = history(30);
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }] } }, blocked: (r) => r.shard === 63 });
        await seed(w, { sha: hist[25], specs: { 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: SIG } } });
        const out = await w.engine.run(prRequest({ mergeBase: hist[25] }), w.inputs({ mainHistory: hist }));
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'failed_unconfirmed' });
    });

    it('a baseline of another suite (a changed command, glob or spec list) is not found, so main is re-run', async () => {
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }] } } });
        await seed(w, { digest: 'f'.repeat(64), specs: { 'old.cy.ts': { status: 'failed', durationMs: 1, errorSignature: SIG } } });
        await w.engine.run(prRequest(), w.inputs({ mainHistory: [MAIN] }));
        expect(w.cell.acquires.filter((a) => a.ref.side === 'base')).toHaveLength(1);
    });

    it('how far main is ahead of the merge base is counted from the history, and a spec the diff does not reach is then unconfirmed', async () => {
        const hist = history(5);
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } });
        const out = await w.engine.run(prRequest({ mergeBase: hist[3] }), w.inputs({ mainHistory: hist }));
        expect(out.classification?.tests[0]).toMatchObject({ class: 'regression_unconfirmed', baseDrift: 3 });
    });

    it('keeps on the run how the specs were chosen, the baseline it used and how far main had moved', async () => {
        const w = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: ERR }] } } });
        const hist = history(3);
        seed(w, { sha: hist[1], specs: { 'red.cy.ts': { status: 'passed', durationMs: 1000 }, ...Object.fromEntries(Object.keys(oks).map((k) => [k, { status: 'passed' as const, durationMs: 1000 }])) } });
        await w.engine.run(prRequest({ mergeBase: hist[1] }), w.inputs({ mainHistory: hist, selection: { mode: 'full', reason: 'map_missing', total: 11 } }));
        const run = await w.runs.get(ORG, 'sr-1');
        expect(run).toMatchObject({ selection: { mode: 'full', reason: 'map_missing', total: 11 }, baselineSha: hist[1], baseDrift: 1 });
    });
});
