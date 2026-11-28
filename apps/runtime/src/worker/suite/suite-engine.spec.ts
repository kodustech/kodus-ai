import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { acquireSuiteClaim, type SuiteConfig, SuiteEngine } from './suite-engine';
import { CellUnavailableError } from '../../shared/errors';

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

    it('keeps asking for the hosts while it waits for them, so a host that registers after the demand row would lapse still serves its shard', async () => {
        // dev, 2026-11-25: the suite asked once, the rows lapsed after 120 s, and the three hosts that registered at 3 min
        // were ended as served the second they came; every spec was infra.
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'b.cy.ts': { ms: MIN }, 'c.cy.ts': { ms: MIN } } });
        const start = w.clock.now();
        w.demand.readyAt = start + 3 * MIN;
        const out = await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']));
        const beforeHosts = w.demand.requested.filter((_, i) => w.demand.requestedAt[i] > start && w.demand.requestedAt[i] < start + 3 * MIN);
        expect(beforeHosts.length).toBeGreaterThanOrEqual(3);
        for (const shards of beforeHosts) expect([...shards].sort()).toEqual([0, 1, 2]);
        expect(Object.values(statusOf(out))).toEqual(['passed', 'passed', 'passed']);
    });

    it('records when each shard got its host ready and when its specs ended, so the page can say where the time went', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 2 * MIN }, 'b.cy.ts': { ms: MIN } } }, { maxShards: 2 });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        for (const shard of [0, 1]) {
            const m = w.runs.moments.get(`sr-1|${shard}`)!;
            expect(m.running).toBeDefined();
            expect(m.finished! - m.running!).toBeGreaterThanOrEqual(MIN);
        }
        expect((await w.runs.shards(ORG, 'sr-1')).map((s) => s.state)).toEqual(['finished', 'finished']);
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

    it('a run with a deadline (the Run\'s 45 minutes) never goes past it: the shard is stopped there, the rest is not_run and nothing re-runs after it', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'b.cy.ts': { ms: 90 * MIN } } }, { maxShards: 1 });
        const started = w.clock.now();
        const out = await w.engine.run(request(), { ...w.inputs(['a.cy.ts', 'b.cy.ts']), deadlineAt: started + 10 * MIN });
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'not_run' });
        expect(out.state).toBe('neutral');
        // Polling granularity aside, the run ends at the deadline, not at the recipe's 25 minute shard cap or the 12 minute re-run phase.
        expect(w.clock.now() - started).toBeLessThanOrEqual(10 * MIN + 2 * MIN);
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
        // Two starts in the shard's claim, then one on a fresh host that crashes the same way.
        expect(w.cell.starts.map((x) => x.claimId)).toEqual(['claim:suite:sr-1:0', 'claim:suite:sr-1:0', 'claim:suite:sr-1:62:0']);
        expect(out.state).toBe('neutral');
    });

    it('a runner that left no result at all is infra for the whole shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} } }, { maxShards: 1 });
        expect(statusOf(await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts'])))).toEqual({ 'a.cy.ts': 'infra', 'b.cy.ts': 'infra' });
    });

    // kr-mono on dev: 75 Cypress specs stored as infra with nothing more, because the image had no Cypress binary.
    it("stores why the runner reported nothing with each infra spec: the reason and the runner's last error line", async () => {
        const w = world({ specs: { 'a.cy.ts': { pr: ['crash'] }, 'b.cy.ts': {} }, log: 'Error: The cypress npm package is installed, but the Cypress binary is missing.' }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        const infra = (await w.runs.results(ORG, 'sr-1')).filter((r) => r.status === 'infra');
        expect(infra.length).toBeGreaterThan(0);
        for (const r of infra) expect(r.errorSignature).toMatch(/^(?:no_result_file|crashed).*: Error: The cypress npm package is installed, but the Cypress binary is missing\.$/);
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

    it('a shard whose claim is blocked has its specs as infra when no sibling can take them (and no fresh host to retry them on)', async () => {
        const w = world({ specs: Object.fromEntries(['a', 'b', 'c'].map((n) => [`${n}.cy.ts`, { ms: 4 * MIN }])), blocked: () => true }, { maxShards: 1 });
        const out = await w.engine.run(request(), w.inputs(['a', 'b', 'c'].map((n) => `${n}.cy.ts`)));
        expect(Object.values(statusOf(out))).toEqual(['infra', 'infra', 'infra']);
    });

    it('a shard whose claim is blocked has its specs run by the siblings that finish, on the PR build they hold', async () => {
        const w = world({ specs: Object.fromEntries(['a', 'b', 'c'].map((n) => [`${n}.cy.ts`, { ms: 4 * MIN }])), blocked: (r) => r.shard === 1 || r.shard === 62 });
        const out = await w.engine.run(request(), w.inputs(['a', 'b', 'c'].map((n) => `${n}.cy.ts`)));
        expect(Object.values(statusOf(out))).toEqual(['passed', 'passed', 'passed']);
        expect(out.firstPass.every((s) => s.shard !== 1)).toBe(true);
    });

    it('asks for its hosts again while it runs, so the demand row (120 s) never lapses under a long shard', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 12 * MIN } } }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts']));
        const at = w.demand.requestedAt;
        expect(at.length).toBeGreaterThan(5);
        for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThanOrEqual(60_000);
    });

    it('learns the durations of the specs that passed and of the ones that failed: a failing spec costs its shard that time too', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 2 * MIN }, 'b.cy.ts': { ms: 3 * MIN, pr: [{ fail: 'boom' }] } } }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a.cy.ts', 'b.cy.ts']));
        expect(await w.stats.read({ organizationId: ORG, environmentId: ENV }, ['a.cy.ts', 'b.cy.ts'])).toEqual({ 'a.cy.ts': { p50Ms: 2 * MIN }, 'b.cy.ts': { p50Ms: 3 * MIN } });
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

    it('runs the specs red on the previous push, then those that cover the diff, first in their shard, and balances the same', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: 10_000 }, 'b.cy.ts': { ms: 20_000 }, 'c.cy.ts': { ms: 30_000 } } }, { maxShards: 1 });
        await w.engine.run(request(), { ...w.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']), order: { failedBefore: ['c.cy.ts'], diffCoverage: { 'b.cy.ts': 2 } } });
        expect(w.cell.starts[0].specs).toEqual(['c.cy.ts', 'b.cy.ts', 'a.cy.ts']);
        const w2 = world({ specs: { 'a.cy.ts': { ms: 10_000 }, 'b.cy.ts': { ms: 20_000 }, 'c.cy.ts': { ms: 30_000 } } }, { maxShards: 1 });
        await w2.engine.run(request(), w2.inputs(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']));
        // Without the order input the specs keep their path order (no stored duration yet).
        expect(w2.cell.starts[0].specs).toEqual(['a.cy.ts', 'b.cy.ts', 'c.cy.ts']);
    });

    describe('fail fast', () => {
        const names = Array.from({ length: 10 }, (_, i) => `s${i}.cy.ts`);
        const red = { pr: [{ fail: 'boom' }], ms: MIN };
        const spec = (failing: string[]) => Object.fromEntries(names.map((n) => [n, failing.includes(n) ? red : { ms: MIN }]));

        it('stops the first pass when more than 25% of the first batch failed: the command is stopped, the rest is not_run, nothing re-runs and the classifier sees a mass failure', async () => {
            const w = world({ specs: spec(['s0.cy.ts', 's1.cy.ts']) }, { maxShards: 1 });
            const started = w.clock.now();
            const out = await w.engine.run(request(), w.inputs(names));
            expect(statusOf(out)).toEqual({ ...Object.fromEntries(names.map((n) => [n, 'not_run'])), 's0.cy.ts': 'failed', 's1.cy.ts': 'failed' });
            // Two minutes of work and a poll, not ten.
            expect(w.clock.now() - started).toBeLessThan(4 * MIN);
            // No re-run on the PR or main, and the not-run specs are not given a fresh host either.
            expect(w.cell.starts).toHaveLength(1);
            expect(out.classification?.massFailure).toBe(true);
            expect(out.state).toBe('neutral');
        });

        it('across shards: one shard seeing the failures stops the others too', async () => {
            const w = world({ specs: spec(['s0.cy.ts', 's1.cy.ts', 's2.cy.ts']) }, { maxShards: 2 });
            const started = w.clock.now();
            const out = await w.engine.run(request(), w.inputs(names));
            expect(Object.values(statusOf(out)).filter((s) => s === 'not_run').length).toBeGreaterThanOrEqual(4);
            expect(w.clock.now() - started).toBeLessThan(6 * MIN);
            expect(out.classification?.massFailure).toBe(true);
        });

        it('goes on when failures stay within 25% of the first batch', async () => {
            const w = world({ specs: spec(['s0.cy.ts']) }, { maxShards: 1 });
            const out = await w.engine.run(request(), w.inputs(names));
            expect(Object.values(statusOf(out)).filter((s) => s === 'passed')).toHaveLength(9);
            expect(out.classification?.massFailure).toBe(false);
        });

        it('a baseline is never cut short: it is main alone and must be complete', async () => {
            const w = world({ specs: Object.fromEntries(names.map((n) => [n, { main: [{ fail: 'boom' } as const], ms: MIN }])) }, { maxShards: 1 });
            const out = await w.engine.run(request({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), w.inputs(names));
            expect(Object.values(statusOf(out)).filter((s) => s === 'failed')).toHaveLength(10);
        });
    });

    describe('cancelling a running suite', () => {
        const names = ['a.cy.ts', 'b.cy.ts', 'c.cy.ts', 'd.cy.ts'];

        it('stops every command, releases every claim, ends the demand and closes the run cancelled: no re-run, no classification, no regression', async () => {
            const w = world({ specs: Object.fromEntries(names.map((n) => [n, { ms: 10 * MIN, ...(n === 'a.cy.ts' ? { pr: [{ fail: 'boom' }] } : {}) }])) }, { maxShards: 2 });
            const stop = new AbortController();
            const started = w.clock.now();
            // A newer push arrives while the shards run.
            const sleep = w.clock.sleep;
            let polls = 0;
            w.clock.sleep = async (ms) => {
                await sleep(ms);
                if (++polls === 4) stop.abort();
            };
            const out = await w.engine.run(request(), { ...w.inputs(names), signal: stop.signal });
            expect(out.state).toBe('cancelled');
            expect(out.classification).toBeUndefined();
            expect((await w.runs.get(ORG, 'sr-1'))?.state).toBe('cancelled');
            expect([...w.cell.claims.values()].every((c) => c.released)).toBe(true);
            expect(w.demand.ended).toBe(1);
            // Nothing after the cancel: no re-run of the red spec, no fresh host, no main host.
            expect(w.cell.acquires.map((a) => a.shard).sort()).toEqual([0, 1]);
            expect(w.clock.now() - started).toBeLessThan(5 * MIN);
        });

        it('a cancel before the hosts came takes no claim at all', async () => {
            const w = world({ specs: { 'a.cy.ts': {} } }, { maxShards: 1 });
            const stop = new AbortController();
            stop.abort();
            const out = await w.engine.run(request(), { ...w.inputs(['a.cy.ts']), signal: stop.signal });
            expect(out.state).toBe('cancelled');
            expect(w.cell.starts).toEqual([]);
            expect(w.demand.ended).toBe(1);
        });
    });
});

describe('the time a spec costs a shard', () => {
    it('stores a passing spec at the wall time it cost, the runner\'s start for each spec included, not at the duration the report gives', async () => {
        // Cypress under gVisor: every spec reports 30 s but costs 80 s of the shard (50 s opening the browser).
        const w = world({ overheadMs: 50_000, specs: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`${n}.cy.ts`, { ms: 30_000 }])) }, { maxShards: 1 });
        await w.engine.run(request(), w.inputs(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.cy.ts`)));
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) expect(Math.abs(w.stats.rows.get(`${ORG}|${ENV}|${n}.cy.ts`)!.p50Ms - 80_000)).toBeLessThanOrEqual(5_000);
    });

    it('plans one more shard when the stored wall times no longer fit the target in the shards it had', async () => {
        const specs = Array.from({ length: 12 }, (_, i) => `s${i}.cy.ts`);
        const w = world({ specs: Object.fromEntries(specs.map((s) => [s, { ms: 30_000 }])) }, { maxShards: 8 });
        // 12 specs at 80 s is 16 min of work: two 8 minute shards.
        for (const s of specs) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec: s, status: 'passed', durationMs: 80_000 }]);
        await w.engine.run(request(), w.inputs(specs));
        expect(w.demand.requested[0]).toEqual([0, 1]);
    });

    it('plans for the shard cap, not only the target: a shard that may run 5 minutes is planned 4 minutes of work', async () => {
        const specs = Array.from({ length: 10 }, (_, i) => `s${i}.cy.ts`);
        const w = world({ specs: Object.fromEntries(specs.map((s) => [s, { ms: 30_000 }])) }, { maxShards: 8, shardTimeoutMs: 5 * MIN });
        for (const s of specs) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec: s, status: 'passed', durationMs: 60_000 }]);
        await w.engine.run(request(), w.inputs(specs));
        // 10 minutes of work: two shards by the 8 minute target, three by the 4 minutes the cap allows.
        expect(w.demand.requested[0]).toEqual([0, 1, 2]);
    });
});

describe('a shard whose host is ready late', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.cy.ts`);
    const late = () => {
        const w = world({ acquireDelayMs: (r) => (r.shard === 0 ? 20 * MIN : undefined), specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { maxShards: 3 });
        return w;
    };
    const seed = async (w: ReturnType<typeof late>) => {
        for (const s of six) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec: s, status: 'passed', durationMs: 4 * MIN }]);
    };

    it('has its specs run by the siblings that finished, on the PR build they hold, instead of leaving them not_run', async () => {
        const w = late();
        await seed(w);
        const started = w.clock.now();
        const out = await w.engine.run(request(), w.inputs(six));
        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
        // Not waited for: the run ends long before the late host would have been ready.
        expect(w.clock.now() - started).toBeLessThan(12 * MIN);
        const lateSpecs = (await w.runs.shards(ORG, 'sr-1')).find((s) => s.shard === 0)!.specs;
        expect(lateSpecs).toEqual([]);
        expect(out.firstPass.filter((s) => s.shard === 0)).toEqual([]);
    });

    it('runs what is left of its own specs when its host comes up while a sibling is still busy, and no spec runs twice', async () => {
        const w = world({ acquireDelayMs: (r) => (r.shard === 0 ? 3 * MIN : undefined), specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { maxShards: 3 });
        await seed(w as never);
        const out = await w.engine.run(request(), w.inputs(six));
        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
        const ran = w.cell.starts.flatMap((s) => s.specs);
        expect([...ran].sort()).toEqual([...six].sort());
    });

    it('a late host that never comes (blocked) leaves its specs to the siblings, and with no sibling free they are infra for the fresh host', async () => {
        const w = world({ blocked: (r) => r.shard === 0, specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { maxShards: 3 });
        await seed(w as never);
        const out = await w.engine.run(request(), w.inputs(six));
        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
    });
});

// A worker that restarts resumes the suite at once, while the shards' cells are still reconnecting to a hub that
// restarted with it: the hub answers cell_unavailable for the host the shard holds. The suite lived on before; it ended
// errored there, with its hosts still up and its shards left running.
describe("a shard's claim while its cell reconnects to the hub", () => {
    const request = { organizationId: 'org-a', environmentId: 'env-1', runId: 'sr-1', idempotencyKey: 'suite:sr-1:0', consumer: 'suite', suiteRunId: 'sr-1', shard: 0, ref: { side: 'base', sha: 'a'.repeat(40) } } as any;
    const ready = { claimId: 'claim-1' } as any;
    const clock = () => {
        let t = 0;
        return { now: () => t, sleep: async (ms: number) => void (t += ms) };
    };

    it('asks again with the same key until the cell is back, and gets the claim', async () => {
        const c = clock();
        const keys: string[] = [];
        const answers: Array<() => Promise<any>> = [async () => { throw new CellUnavailableError('cell-1'); }, async () => { throw new CellUnavailableError('cell-1'); }, async () => ready];
        const env = { acquire: async (req: any) => (keys.push(req.idempotencyKey), answers.shift()!()) };

        expect(await acquireSuiteClaim(env, request, c, 10 * 60_000)).toBe(ready);
        expect(keys).toEqual(['suite:sr-1:0', 'suite:sr-1:0', 'suite:sr-1:0']);
    });

    it('ends with the error once the cell stays away past the deadline', async () => {
        const c = clock();
        const env = { acquire: async () => { throw new CellUnavailableError('cell-1'); } };

        await expect(acquireSuiteClaim(env, request, c, 60_000)).rejects.toBeInstanceOf(CellUnavailableError);
        expect(c.now()).toBeLessThanOrEqual(60_000);
    });
});
