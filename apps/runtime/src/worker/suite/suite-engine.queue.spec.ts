import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { QUEUE_LEASE_MS, queueEntries } from '@libs/runtime/suite';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteCoverageMaps, InMemorySuiteQueue, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine } from './suite-engine';

// docs/runtime/e2e-suites.md section 6, dynamic queue: every shard pulls the next spec (or a small batch) from a per-run queue
// until it is empty, a lost shard's claims go back to the others, and the results model is the one of a fixed plan.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 2 };
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
    requestedAt: '2026-11-27T12:00:00.000Z',
    key: 'sr-1',
    ...over,
});
const files = (...paths: string[]) => paths.map((path) => ({ path, sizeBytes: 100 }));

function world(spec: FakeSuiteWorld, o: { queue: boolean; cfg?: Partial<SuiteConfig> }) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, spec);
    const runs = new InMemorySuiteRuns(clock);
    const stats = new InMemorySuiteSpecStats();
    const demand = new FakeSuiteDemand(clock);
    const queue = new InMemorySuiteQueue();
    const maps = new InMemorySuiteCoverageMaps();
    const engine = new SuiteEngine({ env: cell, runs, stats, demand, clock, maps, ...(o.queue ? { queue } : {}) });
    const inputs = (paths: string[], extra: Record<string, unknown> = {}) => ({ config: { ...config, ...o.cfg }, specs: files(...paths), ...extra });
    return { clock, cell, runs, stats, demand, queue, maps, engine, inputs };
}
const statusOf = (o: { firstPass: Array<{ spec: string; status: string }> }) => Object.fromEntries(o.firstPass.map((s) => [s.spec, s.status]));
const six = ['a-slow', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.cy.ts`);
const sixWorld = { specs: Object.fromEntries(six.map((s) => [s, { ms: s.startsWith('a-slow') ? 10 * MIN : MIN }])) } satisfies FakeSuiteWorld;
const wrongStats = async (w: ReturnType<typeof world>, paths: string[]) => {
    for (const spec of paths) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec, status: 'passed', durationMs: 4 * MIN }]);
};

describe('the dynamic spec queue in the first pass', () => {
    // A spec whose stored time is wrong (it takes 10 minutes, the stats say 4) makes its shard the tail with a fixed plan; with the queue the other shard takes the rest meanwhile.
    it('does not let a slow shard become the tail: the other shard drains the queue while it runs the slow spec', async () => {
        const fixed = world(sixWorld, { queue: false });
        await wrongStats(fixed, six);
        const t0 = fixed.clock.now();
        await fixed.engine.run(request(), fixed.inputs(six));
        const fixedMs = fixed.clock.now() - t0;

        const dynamic = world(sixWorld, { queue: true });
        await wrongStats(dynamic, six);
        const t1 = dynamic.clock.now();
        const out = await dynamic.engine.run(request(), dynamic.inputs(six));
        const dynamicMs = dynamic.clock.now() - t1;

        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
        expect(dynamicMs).toBeLessThan(fixedMs);
        // The shard that took the slow spec took nothing else while it ran.
        const slowShard = dynamic.cell.starts.find((s) => s.specs.includes('a-slow.cy.ts'))!;
        expect(slowShard.specs).toEqual(['a-slow.cy.ts']);
        expect(dynamic.cell.starts.filter((s) => s.claimId === slowShard.claimId)).toHaveLength(1);
    });

    // Whatever the shards do, a spec is run once: the commands the cell saw hold every spec exactly one time.
    it('runs every spec exactly once across the shards', async () => {
        const w = world(sixWorld, { queue: true, cfg: { maxShards: 3 } });
        await wrongStats(w, six);
        await w.engine.run(request(), w.inputs(six));
        expect(w.cell.starts.flatMap((s) => s.specs).sort()).toEqual([...six].sort());
    });

    // The run's record says who ran what: the stored plan lists the specs each shard pulled, not the estimate it started from.
    it('rewrites the stored plan to the specs each shard pulled and stores one result per spec', async () => {
        const w = world(sixWorld, { queue: true });
        await wrongStats(w, six);
        const out = await w.engine.run(request(), w.inputs(six));
        const plan = await w.runs.shards(ORG, 'sr-1');
        expect(plan.flatMap((s) => s.specs).sort()).toEqual([...six].sort());
        expect(out.firstPass.map((s) => s.shard).sort()).toEqual(six.map((s) => plan.find((p) => p.specs.includes(s))!.shard).sort());
        expect((await w.runs.results(ORG, 'sr-1')).filter((r) => r.phase === 'shard')).toHaveLength(6);
    });

    // Short specs ride in one command (one runner start for all of them); a spec as long as the batch target goes alone.
    it('hands short specs to a shard together and a long spec alone', async () => {
        const w = world({ specs: Object.fromEntries(['p', 'q', 'r', 's'].map((n) => [`${n}.cy.ts`, { ms: 10_000 }])) }, { queue: true, cfg: { maxShards: 1 } });
        for (const n of ['p', 'q', 'r', 's']) await w.stats.record({ organizationId: ORG, environmentId: ENV }, 'x', [{ spec: `${n}.cy.ts`, status: 'passed', durationMs: 10_000 }]);
        await w.engine.run(request(), w.inputs(['p', 'q', 'r', 's'].map((n) => `${n}.cy.ts`)));
        // 4 x 10 s: six of them would fill the minute, so the four ride together.
        expect(w.cell.starts).toHaveLength(1);
        expect(w.cell.starts[0].specs).toHaveLength(4);
    });

    // A host that is lost mid-run gives its specs back: the other shard runs them, and nothing is reported infra or sent to a fresh host.
    it('gives the unfinished specs of a shard that lost its host to the other shard', async () => {
        const w = world({ specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { queue: true });
        await wrongStats(w, six);
        w.cell.loseHostOf('claim:suite:sr-1:0');
        const out = await w.engine.run(request(), w.inputs(six));
        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
        expect(out.state).toBe('passed');
        expect(w.cell.acquires.some((a) => a.shard === 62)).toBe(false);
        expect(out.firstPass.every((s) => s.shard === 1)).toBe(true);
    });

    // A shard that died while holding a claim (no word, no release) has its spec re-queued after the lease and run by a living shard, not before.
    it('re-queues the claim of a shard that went silent after the lease timeout and runs it elsewhere', async () => {
        const w = world({ specs: Object.fromEntries(['a', 'b', 'c'].map((n) => [`${n}.cy.ts`, { ms: MIN }])) }, { queue: true });
        const paths = ['a', 'b', 'c'].map((n) => `${n}.cy.ts`);
        await wrongStats(w, paths);
        // An earlier attempt of this step (shard 9) claimed b and died with it.
        await w.queue.seed(ORG, 'sr-1', queueEntries({ specs: files(...paths), stats: { 'a.cy.ts': { p50Ms: MIN }, 'b.cy.ts': { p50Ms: MIN }, 'c.cy.ts': { p50Ms: MIN } } }));
        await w.queue.claimNext({ organizationId: ORG, suiteRunId: 'sr-1', shard: 9, now: new Date(w.clock.now()), maxSpecs: 1 });
        const claimedAt = w.clock.now();
        const out = await w.engine.run(request(), w.inputs(paths));
        expect(Object.values(statusOf(out))).toEqual(Array(3).fill('passed'));
        // The ghost's spec could only be taken once its lease was over.
        expect(w.clock.now() - claimedAt).toBeGreaterThanOrEqual(QUEUE_LEASE_MS);
    });

    // A shard whose claim is slow to come is not waited for once the queue is empty: it takes nothing and the run ends without it.
    it('does not wait for a shard whose host is ready after the queue was drained', async () => {
        const w = world({ acquireDelayMs: (r) => (r.shard === 1 ? 30 * MIN : undefined), specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { queue: true });
        await wrongStats(w, six);
        const t0 = w.clock.now();
        const out = await w.engine.run(request(), w.inputs(six));
        expect(Object.values(statusOf(out))).toEqual(Array(6).fill('passed'));
        expect(w.clock.now() - t0).toBeLessThan(15 * MIN);
        expect(out.firstPass.every((s) => s.shard === 0)).toBe(true);
    });

    // With no shard's claim granted nothing can run the queue: every spec is infra and goes to the fresh host, as with a fixed plan.
    it('sends every spec to the fresh host when no shard got its claim', async () => {
        const w = world({ blocked: (r) => r.shard !== undefined && r.shard < 62, specs: Object.fromEntries(six.map((s) => [s, { ms: MIN }])) }, { queue: true });
        await wrongStats(w, six);
        const out = await w.engine.run(request(), w.inputs(six));
        expect(out.firstPass).toHaveLength(6);
        expect(out.firstPass.every((s) => s.shard === 62 && s.status === 'passed')).toBe(true);
    });

    // A shard stopped by fail fast pulls nothing more: what is still in the queue is not_run, like the rest of a fixed plan.
    it('leaves what is still queued as not_run when fail fast stops the pass', async () => {
        const names = Array.from({ length: 10 }, (_, i) => `s${i}.cy.ts`);
        const w = world({ specs: Object.fromEntries(names.map((n, i) => [n, i < 3 ? { pr: [{ fail: 'boom' }], ms: MIN } : { ms: MIN }])) }, { queue: true, cfg: { maxShards: 1 } });
        const out = await w.engine.run(request(), w.inputs(names));
        expect(Object.values(statusOf(out)).filter((s) => s === 'not_run').length).toBeGreaterThanOrEqual(4);
        expect(out.classification?.massFailure).toBe(true);
    });

    // The stored results of specs an earlier attempt finished are read back: a replayed step judges the whole suite, not what was left.
    it('reads back the results an earlier attempt of the step stored for specs it finished', async () => {
        const w = world({ specs: { 'a.cy.ts': { ms: MIN }, 'b.cy.ts': { ms: MIN } } }, { queue: true, cfg: { maxShards: 1 } });
        const paths = ['a.cy.ts', 'b.cy.ts'];
        await w.runs.create({ suiteRunId: 'sr-1', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'ci', mainSha: 'a'.repeat(40), requestedAt: new Date('2026-11-27T12:00:00Z') });
        await w.queue.seed(ORG, 'sr-1', queueEntries({ specs: files(...paths), stats: {} }));
        await w.queue.claimNext({ organizationId: ORG, suiteRunId: 'sr-1', shard: 0, now: new Date(w.clock.now()), maxSpecs: 1 });
        await w.queue.complete(ORG, 'sr-1', ['a.cy.ts'], new Date(w.clock.now()));
        await w.runs.recordResults(ORG, 'sr-1', { phase: 'shard', shard: 0 }, [{ spec: 'a.cy.ts', status: 'passed', durationMs: 5_000, tests: [{ title: 'a works', status: 'passed', attempts: [{ status: 'passed', ms: 5_000 }] }] }]);
        const out = await w.engine.run(request(), w.inputs(paths));
        expect(statusOf(out)).toEqual({ 'a.cy.ts': 'passed', 'b.cy.ts': 'passed' });
        expect(w.cell.starts.flatMap((s) => s.specs)).toEqual(['b.cy.ts']);
    });

    // A baseline that collects coverage runs one spec per command and never two at once against a service, queue or not.
    it('keeps a baseline with coverage to one spec per command, one at a time on a claim', async () => {
        const paths = ['a.cy.ts', 'b.cy.ts', 'c.cy.ts'];
        const w = world({ specs: Object.fromEntries(paths.map((p) => [p, { ms: 30_000, covers: [`src/${p}`] }])) }, { queue: true, cfg: { maxShards: 1 } });
        const out = await w.engine.run(request({ mode: 'baseline', prNumber: undefined, prSha: undefined, mergeBase: undefined }), w.inputs(paths, { coverage: true }));
        expect(Object.values(statusOf(out))).toEqual(Array(3).fill('passed'));
        expect(w.cell.starts.every((s) => s.specs.length === 1)).toBe(true);
        expect(w.cell.maxConcurrentOnClaim).toBe(1);
        expect(Object.keys((await w.maps.newest(ORG, ENV))!.specs).sort()).toEqual(paths);
    });
});
