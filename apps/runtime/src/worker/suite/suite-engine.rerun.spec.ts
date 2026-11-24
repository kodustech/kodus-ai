import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine, type SuiteEngineDeps, type SuiteInputs } from './suite-engine';

// docs/runtime/e2e-suites.md section 9: what the engine does with the specs that failed in the first pass. The PR
// re-run stays on the shard host that holds the PR build; the main re-run goes to a template host; the classifier says
// whose fault each red test is. The seeded fixture's runner is a fake cell that gives each spec, side and attempt an
// outcome, so every row of the rules runs end to end.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const ERR = 'expected 3 got 4';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 1 };
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1',
    organizationId: ORG,
    environmentId: ENV,
    repositoryId: 'repo-1',
    mode: 'ci',
    prNumber: 7,
    prSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-23T12:00:00.000Z',
    key: 'sr-1',
    ...over,
});

function world(scenario: FakeSuiteWorld, over: { cfg?: Partial<SuiteConfig>; deps?: Partial<SuiteEngineDeps>; inputs?: Partial<SuiteInputs> } = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, scenario);
    const runs = new InMemorySuiteRuns(clock);
    const demand = new FakeSuiteDemand(clock);
    const engine = new SuiteEngine({ env: cell, runs, stats: new InMemorySuiteSpecStats(), demand, clock, ...over.deps });
    const specs = Object.keys(scenario.specs);
    const run = (r: Partial<RuntimeSuiteRequested> = {}) => engine.run(request(r), { config: { ...config, ...over.cfg }, specs: specs.map((path) => ({ path, sizeBytes: 100 })), ...over.inputs });
    return { cell, runs, demand, run };
}
/** Specs that pass: with the one under test they keep the red share of the suite under 25% (a larger share is the environment, 9.4). */
const oks = Object.fromEntries(['o1', 'o2', 'o3', 'o4', 'o5'].map((n) => [`${n}.cy.ts`, {}]));
const classOf = (o: { classification?: { tests: Array<{ spec: string; class: string }> } }) => Object.fromEntries((o.classification?.tests ?? []).map((t) => [t.spec, t.class]));

describe('re-running what failed in the first pass', () => {
    it('a test that fails on the PR twice and passes on main is a regression, and the run is failed', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'reg.cy.ts': 'regression' });
        expect(out.classification?.tests[0]).toMatchObject({ blocks: true, finding: true });
        expect(out.state).toBe('failed');
    });

    it('keeps the classification on the run, so the publisher reads what each red test was after the engine is gone', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } });
        const out = await w.run();
        const stored = await w.runs.get(ORG, 'sr-1');
        expect(stored?.classification).toEqual(out.classification);
        expect(stored?.classification?.tests[0]).toMatchObject({ spec: 'reg.cy.ts', class: 'regression' });
    });

    it('fails on the PR twice and on main with the same error: pre-existing, which never fails the run', async () => {
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }], main: [{ fail: ERR }] } } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'pre_existing' });
        expect(out.state).toBe('passed');
    });

    it('fails on main with another error: pre-existing changed, flagged for a person but not blocking', async () => {
        const w = world({ specs: { ...oks, 'old.cy.ts': { pr: [{ fail: ERR }], main: [{ fail: 'the page is blank' }] } } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'old.cy.ts': 'pre_existing_changed' });
        expect(out.state).toBe('passed');
    });

    it('passes on the PR re-run: flaky, whatever main said, and it does not block', async () => {
        const w = world({ specs: { ...oks, 'flaky.cy.ts': { pr: [{ fail: ERR }, 'pass'] } } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'flaky.cy.ts': 'flaky' });
        expect(out.state).toBe('passed');
        expect(out.classification?.tests[0]).toMatchObject({ blocks: false, finding: false });
    });

    it('re-runs on the shard host that holds the PR build, and on one template host for main, both asked as demand rows of the run', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } });
        await w.run();
        const first = w.cell.starts[0].claimId;
        // Starts: the first pass, then the PR re-run in the same claim, then main's in another.
        expect(w.cell.starts.map((s) => s.specs)).toEqual([[...Object.keys(oks), 'reg.cy.ts'], ['reg.cy.ts'], ['reg.cy.ts']].map((x) => expect.arrayContaining(x)));
        const byClaim = w.cell.starts.map((s) => s.claimId);
        expect(byClaim.filter((c) => c === first)).toHaveLength(2);
        const main = w.cell.acquires.filter((a) => a.ref.side === 'base');
        expect(main).toEqual([expect.objectContaining({ consumer: 'suite', suiteRunId: 'sr-1', shard: 63, ref: { side: 'base', sha: 'a'.repeat(40) } })]);
        expect(w.cell.acquires.filter((a) => a.ref.side === 'pr')).toHaveLength(1);
        expect(w.demand.requested.some((r) => r.includes(63))).toBe(true);
        expect([...w.cell.claims.values()].every((c) => c.released)).toBe(true);
    });

    it('stores the re-runs as their own phases of the run', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } });
        await w.run();
        const rows = await w.runs.results(ORG, 'sr-1');
        expect(rows.map((r) => `${r.phase}:${r.spec}:${r.status}`).sort()).toEqual(['rerun_main:reg.cy.ts:passed', 'rerun_pr:reg.cy.ts:failed', ...Object.keys(oks).map((o) => `shard:${o}:passed`), 'shard:reg.cy.ts:failed'].sort());
    });

    it('a shard that lost its runner re-runs its specs once on a fresh host: they pass, so the fault was infra', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash', 'pass'] }, 'b.cy.ts': {} } });
        const out = await w.run();
        // The runner died before it reported anything, so both specs of the shard were unreported.
        expect(classOf(out)).toEqual({ 'a.cy.ts': 'infra', 'b.cy.ts': 'infra' });
        expect(out.firstPass.map((s) => s.status)).toEqual(['passed', 'passed']);
        expect(out.state).toBe('passed');
        expect(w.cell.acquires.filter((a) => a.shard === 62)).toHaveLength(1);
    });

    it('infra again on the fresh host is unclassified, never a regression, and the run is neutral', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} } });
        const out = await w.run();
        expect(out.classification?.tests).toEqual([expect.objectContaining({ spec: 'a.cy.ts', class: 'unclassified', reason: 'infra', blocks: false }), expect.objectContaining({ spec: 'b.cy.ts', class: 'unclassified', reason: 'infra', blocks: false })]);
        expect(out.state).toBe('neutral');
    });

    it('specs a shard timeout left unrun are queued once on a fresh host; still unfinished they are unclassified not_run', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'slow.cy.ts': { ms: 90 * MIN } } });
        const out = await w.run();
        expect(out.classification?.tests).toEqual([expect.objectContaining({ spec: 'slow.cy.ts', class: 'unclassified', reason: 'not_run' })]);
        expect(out.state).toBe('neutral');
    });

    it('more than 25% of the specs red is the environment, not the tests: nothing is re-run and nothing is a regression', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: [{ fail: ERR }] }, 'b.cy.ts': { pr: [{ fail: ERR }] }, 'c.cy.ts': {}, 'd.cy.ts': {} } });
        const out = await w.run();
        expect(out.classification?.massFailure).toBe(true);
        expect(Object.values(classOf(out))).toEqual(['unclassified', 'unclassified']);
        expect(w.cell.starts).toHaveLength(1);
        expect(out.state).toBe('neutral');
    });

    it('with no ready template main is not waited for: failed twice on the PR, unconfirmed, and a template build is asked for', async () => {
        const requested: string[] = [];
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } }, { deps: { templates: { hasReady: async () => false, requestBuild: async (o, e) => void requested.push(`${o}/${e}`) } } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'reg.cy.ts': 'failed_unconfirmed' });
        expect(w.cell.acquires.filter((a) => a.ref.side === 'base')).toEqual([]);
        expect(requested).toEqual([`${ORG}/${ENV}`]);
        expect(out.state).toBe('neutral');
    });

    it('with no main host in two attempts the PR is classified without main: unconfirmed, not a finding', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] }, }, blocked: (r) => r.shard === 63 });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'reg.cy.ts': 'failed_unconfirmed' });
        expect(w.cell.acquires.filter((a) => a.shard === 63)).toHaveLength(2);
        expect(out.classification?.tests[0].finding).toBe(false);
    });

    it('a pass on main that is ahead of the merge base, for a spec the diff does not reach, is unconfirmed, not a finding', async () => {
        const w = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } }, { inputs: { baseDrift: 4, diffReachedSpecs: [] } });
        const out = await w.run();
        expect(classOf(out)).toEqual({ 'reg.cy.ts': 'regression_unconfirmed' });
        expect(out.classification?.tests[0].baseDrift).toBe(4);
        expect(out.state).toBe('neutral');
        const reached = world({ specs: { ...oks, 'reg.cy.ts': { pr: [{ fail: ERR }] } } }, { inputs: { baseDrift: 4, diffReachedSpecs: ['reg.cy.ts'] } });
        expect(classOf(await reached.run())).toEqual({ 'reg.cy.ts': 'regression' });
    });

    it('with the strict gate an unclassified failure fails the run; by default it is neutral', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} } }, { cfg: { gate: 'strict' } });
        expect((await w.run()).state).toBe('failed');
    });

    it('a baseline run is the first pass alone: a red spec on main is a result, never re-run or classified', async () => {
        const w = world({ specs: { ...oks, 'red.cy.ts': { main: [{ fail: ERR }] } } });
        const out = await w.run({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined });
        expect(out.classification).toBeUndefined();
        expect(w.cell.starts).toHaveLength(1);
        expect(w.cell.acquires.every((a) => a.ref.side === 'base')).toBe(true);
    });
});
