import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { errorSignature } from '@libs/runtime/suite';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteMainResults, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { MAIN_HOST_SHARD, type SuiteConfig, SuiteEngine } from './suite-engine';

// docs/runtime/e2e-suites.md 7.2, lazy baseline: main is run only for the specs a PR failed, a stored per-spec result of the
// same (environment, main sha, spec, suite digest) is reused, and main's history of a spec feeds the classifier.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const ERR = 'expected 3 got 4';
const MAIN = 'a'.repeat(40);
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 1 };
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1',
    organizationId: ORG,
    environmentId: ENV,
    repositoryId: 'repo-1',
    mode: 'ci',
    prNumber: 7,
    prSha: 'b'.repeat(40),
    mergeBase: MAIN,
    mainSha: MAIN,
    requestedAt: '2026-11-27T12:00:00.000Z',
    key: 'sr-1',
    ...over,
});
const oks = Object.fromEntries(['o1', 'o2', 'o3', 'o4', 'o5'].map((n) => [`${n}.cy.ts`, {}]));

function run(scenario: FakeSuiteWorld, store: InMemorySuiteMainResults, over: Partial<RuntimeSuiteRequested> = {}, extraSpecs: string[] = []) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, scenario);
    const engine = new SuiteEngine({ env: cell, runs: new InMemorySuiteRuns(clock), stats: new InMemorySuiteSpecStats(), demand: new FakeSuiteDemand(clock), clock, mainResults: store });
    const paths = [...Object.keys(scenario.specs), ...extraSpecs];
    return engine.run(request(over), { config, specs: paths.map((path) => ({ path, sizeBytes: 100 })) }).then((out) => ({ out, cell }));
}
const classOf = (o: { classification?: { tests: Array<{ spec: string; class: string }> } }) => Object.fromEntries((o.classification?.tests ?? []).map((t) => [t.spec, t.class]));
const usedMainHost = (cell: FakeSuiteCell) => cell.acquires.some((a) => a.shard === MAIN_HOST_SHARD);

describe('main results kept per spec', () => {
    // The first PR to fail a spec pays a main host; what main said is kept for the next PR on the same commit.
    it('stores what the main re-run said of a failed spec', async () => {
        const store = new InMemorySuiteMainResults();
        const { cell } = await run({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } }, store);
        expect(usedMainHost(cell)).toBe(true);
        expect(store.records).toHaveLength(1);
        expect(store.records[0]).toMatchObject({ source: 'rerun', mainSha: MAIN, rows: [{ spec: 'reg.cy.ts', status: 'passed' }] });
    });

    // A second PR on the same main commit that fails the same spec needs no main host: the stored result answers, with the same verdict.
    it('reuses a stored main result: the next PR failing the same spec starts no main host and gets the same class', async () => {
        const store = new InMemorySuiteMainResults();
        const scenario = { specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } };
        const first = await run(scenario, store);
        const second = await run(scenario, store, { suiteRunId: 'sr-2', key: 'sr-2' });
        expect(classOf(first.out)).toEqual({ 'reg.cy.ts': 'regression' });
        expect(usedMainHost(second.cell)).toBe(false);
        expect(classOf(second.out)).toEqual({ 'reg.cy.ts': 'regression' });
    });

    // A stored failure is reused too: a spec red on main stays pre-existing for the next PR without a host.
    it('reuses a stored failure on main as pre-existing, with no main host', async () => {
        const store = new InMemorySuiteMainResults();
        const scenario = { specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }], main: [{ fail: ERR }] } } };
        await run(scenario, store);
        const second = await run(scenario, store, { suiteRunId: 'sr-2', key: 'sr-2' });
        expect(usedMainHost(second.cell)).toBe(false);
        expect(classOf(second.out)).toEqual({ 'old.cy.ts': 'pre_existing' });
    });

    // A changed suite (a spec added) has another digest: the old main result is not reused and main runs the spec again.
    it('does not reuse a result of another suite digest', async () => {
        const store = new InMemorySuiteMainResults();
        const scenario = { specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } };
        await run(scenario, store);
        const second = await run({ specs: { ...scenario.specs, 'new.cy.ts': {} } }, store, { suiteRunId: 'sr-2', key: 'sr-2' });
        expect(usedMainHost(second.cell)).toBe(true);
    });

    // The same commit gave a pass and a fail: no single run is evidence, so main runs the spec again.
    it('does not reuse a result when the same commit gave different outcomes', async () => {
        const store = new InMemorySuiteMainResults();
        const scenario = { specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } };
        await run(scenario, store);
        const [stored] = store.records;
        await store.record({ ...stored, suiteRunId: 'sr-x', observedAt: new Date(stored.observedAt.getTime() + 1), rows: [{ spec: 'reg.cy.ts', status: 'failed', errorSignature: 'x', tests: [{ title: 't', status: 'failed', errorSignature: 'x' }] }] });
        const third = await run(scenario, store, { suiteRunId: 'sr-3', key: 'sr-3' });
        expect(usedMainHost(third.cell)).toBe(true);
    });

    // A PR with nothing failing never starts main: the lazy rule's whole saving.
    it('starts no main host when nothing failed on the PR', async () => {
        const store = new InMemorySuiteMainResults();
        const { cell } = await run({ specs: oks }, store);
        expect(usedMainHost(cell)).toBe(false);
        expect(store.records).toHaveLength(0);
    });
});

describe('main history feeds the classifier', () => {
    // main gave different outcomes for this spec on one commit, failing with the very error the PR hit: the PR met main's flake.
    it('classifies a PR failure that main also flakes on as flaky, not a regression', async () => {
        const store = new InMemorySuiteMainResults();
        const sig = errorSignature(ERR);
        const seed = (runId: string, status: 'passed' | 'failed', min: number) => store.record({ organizationId: ORG, environmentId: ENV, suiteRunId: runId, mainSha: 'c'.repeat(40), suiteDigest: 'old', source: 'baseline', observedAt: new Date(Date.parse('2026-11-20T00:00:00Z') + min * MIN), rows: [{ spec: 'flk.cy.ts', status, ...(status === 'failed' ? { errorSignature: sig } : {}), tests: [] }] });
        await seed('h1', 'passed', 0);
        await seed('h2', 'failed', 1);
        const { out } = await run({ specs: { ...oks, 'flk.cy.ts': { pr: [{ fail: ERR }] } } }, store);
        expect(classOf(out)).toEqual({ 'flk.cy.ts': 'flaky' });
        expect(out.classification?.tests[0]).toMatchObject({ flakyOnMain: true, blocks: false });
        expect(out.state).toBe('passed');
    });

    // The same failure with no flake in main's history is a regression as before.
    it('keeps a regression when main shows no flake', async () => {
        const { out } = await run({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } }, new InMemorySuiteMainResults());
        expect(classOf(out)).toEqual({ 'reg.cy.ts': 'regression' });
    });
});

describe('a baseline records main per spec', () => {
    // A full run on main is the one place every spec's main result is learned, for the PRs that follow.
    it('stores every spec it ran as a main observation', async () => {
        const store = new InMemorySuiteMainResults();
        const { out } = await run({ specs: { ...oks, 'old.cy.ts': { main: [{ fail: ERR }] } } }, store, { mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined });
        expect(out.state).toBe('failed');
        expect(store.records[0]).toMatchObject({ source: 'baseline', mainSha: MAIN });
        expect(store.records[0].rows.map((r) => [r.spec, r.status]).sort()).toEqual([...Object.keys(oks).map((s) => [s, 'passed']), ['old.cy.ts', 'failed']].sort());
    });
});
