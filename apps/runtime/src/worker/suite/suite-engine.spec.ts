import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine } from './suite-engine';

// docs/runtime/e2e-suites.md sections 2.2, 6, 9.2 and 14: the first pass of a suite run. The shards, the results as
// they stream in, a shard that passes its timeout, a runner that crashes.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 3 };
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
const files = (...paths: string[]) => paths.map((path) => ({ path, sizeBytes: 100 }));

function world(spec: FakeSuiteWorld, cfg: Partial<SuiteConfig> = {}) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, spec);
    const runs = new InMemorySuiteRuns(clock);
    const stats = new InMemorySuiteSpecStats();
    const demand = new FakeSuiteDemand(clock);
    const engine = new SuiteEngine({ env: cell, runs, stats, demand, clock });
    const inputs = (paths: string[]) => ({ config: { ...config, ...cfg }, specs: files(...paths) });
    return { clock, cell, runs, stats, demand, engine, inputs };
}
const statusOf = (o: { firstPass: Array<{ spec: string; status: string }> }) => Object.fromEntries(o.firstPass.map((s) => [s.spec, s.status]));

describe('the first pass of a suite run', () => {
    it('spreads the specs over the hosts it asks for, balanced by the stored durations, one host per shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 9 * MIN }, 'b.cy.ts': { ms: 8 * MIN }, 'c.cy.ts': { ms: 4 * MIN }, 'd.cy.ts': { ms: 3 * MIN }, 'e.cy.ts': { ms: 2 * MIN } } });
        for (const [spec, ms] of [['a.cy.ts', 9], ['b.cy.ts', 8], ['c.cy.ts', 4], ['d.cy.ts', 3], ['e.cy.ts', 2]] as const) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec, status: 'passed', durationMs: ms * MIN }]);
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts', 'd.cy.ts', 'e.cy.ts']));
        expect(w.demand.requested[0]).toEqual([0, 1, 2]);
        const plan = (await w.runs.shards(ORG, 'sr-1')).map((s) => ({ shard: s.shard, specs: [...s.specs].sort() }));
        expect(plan).toEqual([
            { shard: 0, specs: ['a.cy.ts'] },
            { shard: 1, specs: ['b.cy.ts'] },
            { shard: 2, specs: ['c.cy.ts', 'd.cy.ts', 'e.cy.ts'] },
        ]);
        // Each shard's claim is the PR side at the PR's head, of consumer suite, bound to its shard.
        expect(w.cell.acquires.map((a) => ({ consumer: a.consumer, side: a.ref.side, sha: a.ref.sha, suiteRunId: a.suiteRunId, shard: a.shard })).sort((x, y) => x.shard! - y.shard!)).toEqual([0, 1, 2].map((shard) => ({ consumer: 'suite', side: 'pr', sha: 'b'.repeat(40), suiteRunId: 'sr-1', shard })));
    });

    it('records each spec result when its shard has it, not at the end of the shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'b.cy.ts': { ms: MIN }, 'c.cy.ts': { ms: MIN } } }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']));
        const at = (s: string) => w.runs.recordedAt('sr-1', 'shard', s)!;
        expect(at('a.cy.ts')).toBeLessThan(at('b.cy.ts'));
        expect(at('b.cy.ts')).toBeLessThan(at('c.cy.ts'));
        expect(await w.runs.results(ORG, 'sr-1')).toHaveLength(3);
    });

    it('keeps a red spec as a result with its error signature, and a green run ends passed', async () => {
        const red = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': { pr: [{ fail: 'Timed out after 4000ms: no .cart' }] } } }, { maxShards: 1 });
        const out = await red.engine.run(request(), red.inputs(['a.cy.ts', 'b.cy.ts']));
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'failed' });
        expect(out.firstPass.find((s) => s.spec === 'b.cy.ts')?.result?.errorSignature).toBe('Timed out after <n>ms: no .cart');
        const green = world({ specs: { 'a.cy.ts': {} } }, { maxShards: 1 });
        expect((await green.engine.run(request(), green.inputs(['a.cy.ts']))).state).toBe('passed');
    });

    it('a shard past its timeout is stopped; the specs it finished stay results and the rest are not_run', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'b.cy.ts': { ms: 90 * MIN } } }, { maxShards: 1 });
        const out = await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'not_run' });
        expect((await w.runs.results(ORG, 'sr-1')).find((r) => r.spec === 'b.cy.ts')?.status).toBe('not_run');
        // Never red: a spec nobody ran proves nothing, and the run is not a pass.
        expect(out.state).toBe('neutral');
    });

    it('a runner that crashed after some results re-runs the specs it had not reported, once, on the same host', async () => {
        const w = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': { pr: ['crash', 'pass'] }, 'c.cy.ts': {} } }, { maxShards: 1 });
        const out = await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']));
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'passed', 'c.cy.ts': 'passed' });
        expect(w.cell.starts.map((s) => s.specs)).toEqual([['a.cy.ts', 'b.cy.ts', 'c.cy.ts'], ['b.cy.ts', 'c.cy.ts']]);
        expect(new Set(w.cell.starts.map((s) => s.claimId)).size).toBe(1);
    });

    it('a second crash is infra for what is left, never a failure of the PR', async () => {
        const w = world({ specs: { 'a.cy.ts': {}, 'b.cy.ts': { pr: ['crash'] }, 'c.cy.ts': {} } }, { maxShards: 1 });
        const out = await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']));
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'infra', 'c.cy.ts': 'infra' });
        expect(w.cell.starts).toHaveLength(2);
        expect(out.state).toBe('neutral');
    });

    it('a runner that left no result at all is infra for the whole shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} } }, { maxShards: 1 });
        expect(statusOf(await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts'])))).toEqual({ 'a.cy.ts': 'infra', 'b.cy.ts': 'infra' });
    });

    it('a host the fleet could not make is not waited for: its specs go to the shards that came', async () => {
        const w = world({ specs: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`${n}.cy.ts`, { ms: 4 * MIN }])) });
        w.demand.failed.add(2);
        const out = await w.engine.run(request(), w.inputs(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.cy.ts`)));
        expect(out.firstPass.every((s) => s.status === 'passed')).toBe(true);
        const plan = await w.runs.shards(ORG, 'sr-1');
        expect(plan.filter((s) => s.specs.length > 0).map((s) => s.shard)).toEqual([0, 1]);
        expect(plan.flatMap((s) => s.specs).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.cy.ts`));
    });

    it('a shard whose claim is blocked has its specs as infra while the others run', async () => {
        const w = world({ specs: Object.fromEntries(['a', 'b', 'c'].map((n) => [`${n}.cy.ts`, { ms: 4 * MIN }])), blocked: (r) => r.shard === 1 });
        const out = await w.engine.run(request(), w.inputs(['a', 'b', 'c'].map((n) => `${n}.cy.ts`)));
        const bySpec = Object.fromEntries(out.firstPass.map((s) => [s.spec, s]));
        const infra = out.firstPass.filter((s) => s.status === 'infra');
        expect(infra.length).toBeGreaterThan(0);
        expect(infra.every((s) => s.shard === 1)).toBe(true);
        expect(out.firstPass.filter((s) => s.status === 'passed').every((s) => bySpec[s.spec].shard !== 1)).toBe(true);
    });

    it('asks for its hosts again while it runs, so the demand row (120 s) never lapses under a long shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 12 * MIN } } }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts']));
        const at = w.demand.requestedAt;
        expect(at.length).toBeGreaterThan(5);
        for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThanOrEqual(60_000);
    });

    it('learns the durations of the specs that passed and nothing from the ones that failed', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 2 * MIN }, 'b.cy.ts': { ms: 3 * MIN, pr: [{ fail: 'boom' }] } } }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        expect(await w.stats.read({ organizationId: ORG, environmentId: ENV }, ['a.cy.ts', 'b.cy.ts'])).toEqual({ 'a.cy.ts': { p50Ms: 2 * MIN } });
    });

    it('releases every claim and ends its demand when it is done, however it ended', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} } });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        expect([...w.cell.claims.values()].every((c) => c.released)).toBe(true);
        expect(w.demand.ended).toBe(1);
    });

    it('the same request twice runs the suite once', async () => {
        const w = world({ specs: { 'a.cy.ts': {} } }, { maxShards: 1 });
        const first = await w.engine.run(request(), w.inputs(['a.cy.ts']));
        const again = await w.engine.run(request(), w.inputs(['a.cy.ts']));
        expect(first.replayed).toBe(false);
        expect(again).toMatchObject({ replayed: true, state: 'passed' });
        expect(w.cell.starts).toHaveLength(1);
    });
});
