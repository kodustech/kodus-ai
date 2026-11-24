import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine, type SuiteInputs } from './suite-engine';
import type { KeepInput, KeepResult } from './suite-artifacts';

// docs/runtime/e2e-suites.md section 7 and 13 (build-plan step 18) in the engine: after a shard's first pass the artifacts of
// its failed specs are kept, inside the suite's byte budget, and a canary in one halts the suite.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const MAIN = 'a'.repeat(40);
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 1, artifacts: ['cypress/screenshots', 'cypress/videos'] };
const pr: RuntimeSuiteRequested = { suiteRunId: 'sr-1', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'ci', prNumber: 7, prSha: 'b'.repeat(40), mergeBase: MAIN, mainSha: MAIN, requestedAt: '2026-11-23T12:00:00.000Z', key: 'sr-1' };
const baseline: RuntimeSuiteRequested = { ...pr, suiteRunId: 'sr-b', mode: 'baseline', key: 'sr-b' };
const oks = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i + 1}.cy.ts`, {}]));

class FakeKeeper {
    readonly calls: KeepInput[] = [];
    constructor(private readonly answer: (i: KeepInput) => Partial<KeepResult> = () => ({})) {}
    async keep(i: KeepInput): Promise<KeepResult> {
        this.calls.push(i);
        const a = this.answer(i);
        return { artifacts: [], dropped: [], keptBytes: 0, leaked: false, ...a };
    }
}

function world(scenario: FakeSuiteWorld, keeper: FakeKeeper | undefined, over: { config?: Partial<SuiteConfig>; inputs?: Partial<SuiteInputs> } = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, scenario);
    const runs = new InMemorySuiteRuns(clock);
    const engine = new SuiteEngine({ env: cell, runs, stats: new InMemorySuiteSpecStats(), demand: new FakeSuiteDemand(clock), clock, ...(keeper ? { artifacts: keeper } : {}) });
    const c = { ...config, ...over.config };
    const inputs = (extra: Partial<SuiteInputs> = {}): SuiteInputs => ({ config: c, specs: Object.keys(scenario.specs).map((path) => ({ path, sizeBytes: 100 })), ...over.inputs, ...extra });
    return { cell, runs, engine, inputs };
}

describe('the artifacts of a suite run', () => {
    it('keeps those of the specs that failed, from the shard host that ran them, before anything is re-run or released', async () => {
        const keeper = new FakeKeeper((i) => ({ artifacts: [{ spec: 'red.cy.ts', name: 'cypress/screenshots/red.cy.ts/fail.png', key: 'org-a/sr-1/pr/x/suite-artifact', contentType: 'image/png', bytes: 7 }], keptBytes: i.failed.length * 7 }));
        const w = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: 'boom' }] } } }, keeper);
        await w.engine.run(pr, w.inputs());
        expect(keeper.calls).toHaveLength(1);
        expect(keeper.calls[0]).toMatchObject({ organizationId: ORG, suiteRunId: 'sr-1', side: 'pr', shard: 0, cwd: 'apps/dashboard', dirs: ['cypress/screenshots', 'cypress/videos'], failed: ['red.cy.ts'] });
        expect(keeper.calls[0].specs).toHaveLength(11);
        // The claim it read from is the shard's own, and it was still held.
        expect(w.cell.claims.get(keeper.calls[0].claimId)).toBeDefined();
        const row = (await w.runs.results(ORG, 'sr-1')).find((r) => r.spec === 'red.cy.ts' && r.phase === 'shard');
        expect(row?.artifacts).toEqual([{ name: 'cypress/screenshots/red.cy.ts/fail.png', key: 'org-a/sr-1/pr/x/suite-artifact', contentType: 'image/png', bytes: 7 }]);
    });

    it('asks for nothing when no spec failed, on a baseline, and when the recipe names no artifact directory', async () => {
        const green = new FakeKeeper();
        const g = world({ specs: oks }, green);
        await g.engine.run(pr, g.inputs());
        expect(green.calls).toEqual([]);

        const onMain = new FakeKeeper();
        const b = world({ specs: { ...oks, 'red.cy.ts': { main: [{ fail: 'boom' }] } } }, onMain);
        await b.engine.run(baseline, b.inputs());
        expect(onMain.calls).toEqual([]);

        const none = new FakeKeeper();
        const n = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: 'boom' }] } } }, none, { config: { artifacts: [] } });
        await n.engine.run(pr, n.inputs());
        expect(none.calls).toEqual([]);
    });

    it('shares one byte budget between the shards: the second asks only for what the first left', async () => {
        const keeper = new FakeKeeper((i) => ({ keptBytes: i.shard === 0 ? 600 : 0 }));
        const specs = { 'a1.cy.ts': { ms: 5 * MIN, pr: [{ fail: 'x' }] as never }, 'a2.cy.ts': { ms: 5 * MIN }, 'b1.cy.ts': { ms: 5 * MIN, pr: [{ fail: 'y' }] as never }, 'b2.cy.ts': { ms: 5 * MIN } };
        const w = world({ specs: { ...specs, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`ok${i}.cy.ts`, { ms: 5 * MIN }])) } }, keeper, { config: { maxShards: 2 }, inputs: { artifactBudgetBytes: 1000 } });
        await w.engine.run(pr, w.inputs());
        expect(keeper.calls.length).toBeGreaterThanOrEqual(1);
        const remaining = keeper.calls.map((c) => c.remainingBytes);
        expect(remaining[0]).toBe(1000);
        if (keeper.calls.length > 1) expect(remaining[1]).toBe(1000 - keeper.calls.filter((_, i) => i === 0).length * 600);
    });

    it('a canary in an artifact halts the suite: no re-run, no main host, the run ends failed, and it says it leaked', async () => {
        const keeper = new FakeKeeper(() => ({ leaked: true }));
        const w = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: 'boom' }] } } }, keeper);
        const out = await w.engine.run(pr, w.inputs({ canaries: [{ slot: 'npmrc', value: 'v', core: 'c' }] }));
        expect(out).toMatchObject({ state: 'failed', leaked: true });
        expect(out.classification).toBeUndefined();
        expect(w.cell.acquires.filter((a) => a.ref.side === 'base')).toEqual([]);
        // The red spec is not run again on the PR either: one command started, the shard's own.
        expect(w.cell.starts).toHaveLength(1);
        expect(w.cell.claims.size).toBe(w.cell.released.length);
    });

    it('passes the Run\'s canaries to the keeper', async () => {
        const keeper = new FakeKeeper();
        const canaries = [{ slot: 'npmrc' as const, value: 'v', core: 'c' }];
        const w = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: 'boom' }] } } }, keeper);
        await w.engine.run(pr, w.inputs({ canaries }));
        expect(keeper.calls[0].canaries).toEqual(canaries);
    });

    it('a keeper that throws never fails the run: the artifacts are lost, the result stands', async () => {
        const keeper = new FakeKeeper(() => {
            throw new Error('disk');
        });
        const w = world({ specs: { ...oks, 'red.cy.ts': { pr: [{ fail: 'boom' }] } } }, keeper);
        const out = await w.engine.run(pr, w.inputs());
        expect(out.classification?.tests.map((t) => t.class)).toContain('regression');
    });
});
