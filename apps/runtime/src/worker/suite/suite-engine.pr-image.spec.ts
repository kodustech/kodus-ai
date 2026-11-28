import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteCoverageMaps, InMemorySuiteQueue, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine } from './suite-engine';

// docs/runtime/e2e-suites.md 10.2 and D9: a Run's suite runs beside the Run's boot on its own shard hosts. Its PR side builds the PR
// once and publishes the image; a shard waits for that image (bounded by the suite's deadline) and boots from the pull. It never
// rebuilds the PR in parallel, and an image that is not there is a reason on the specs, not an infrastructure failure.

const MIN = 60_000;
const ORG = 'org-a';
const ENV = 'env-shop';
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: {}, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * MIN, maxShards: 2 };
const request = (over: Partial<RuntimeSuiteRequested> = {}): RuntimeSuiteRequested => ({
    suiteRunId: 'sr-1',
    organizationId: ORG,
    environmentId: ENV,
    repositoryId: 'repo-1',
    mode: 'run',
    targetId: 'run-1',
    prNumber: 7,
    prSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-27T12:00:00.000Z',
    key: 'run-1',
    ...over,
} as RuntimeSuiteRequested);
const files = (...paths: string[]) => paths.map((path) => ({ path, sizeBytes: 100 }));
const specs = ['a', 'b', 'c', 'd'].map((n) => `${n}.cy.ts`);

function world(spec: FakeSuiteWorld) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, spec);
    const runs = new InMemorySuiteRuns(clock);
    const demand = new FakeSuiteDemand(clock);
    const engine = new SuiteEngine({ env: cell, runs, stats: new InMemorySuiteSpecStats(), demand, clock, maps: new InMemorySuiteCoverageMaps(), queue: new InMemorySuiteQueue() });
    const inputs = (extra: Record<string, unknown> = {}) => ({ config, specs: files(...specs), ...extra });
    return { clock, cell, runs, demand, engine, inputs };
}
const ok = { specs: Object.fromEntries(specs.map((s) => [s, { ms: MIN }])) } satisfies FakeSuiteWorld;

describe('a Run-mode suite and the PR image its PR side publishes', () => {
    it('asks every PR-side shard to wait for the PR image, and a CI-mode suite does not', async () => {
        const run = world(ok);
        await run.engine.run(request(), run.inputs());
        expect(run.cell.acquires.length).toBeGreaterThan(0);
        expect(run.cell.acquires.every((a) => a.awaitPrImage === true)).toBe(true);

        const ci = world(ok);
        await ci.engine.run(request({ mode: 'ci' }), ci.inputs());
        expect(ci.cell.acquires.some((a) => a.awaitPrImage)).toBe(false);
    });

    it('a shard held past the host wait while the PR image is built still takes its claim, inside the suite deadline', async () => {
        // The hub answers "not yet" for 20 minutes (the PR side is building); the host wait alone is 10.
        const w = world({ ...ok, blocked: () => w.clock.now() < t0 + 20 * MIN });
        const t0 = w.clock.now();
        const out = await w.engine.run(request(), w.inputs({ deadlineAt: t0 + 45 * MIN }));
        expect(out.firstPass.map((s) => s.status)).toEqual(Array(4).fill('passed'));
    });

    it('does not turn the specs into infra when the PR image is not there: they are not_run with the cause, and no fresh host is asked', async () => {
        const w = world({ ...ok, prImageUnavailable: () => 'push_failed' });
        const out = await w.engine.run(request(), w.inputs({ deadlineAt: w.clock.now() + 45 * MIN }));
        expect(out.firstPass.map((s) => s.status)).toEqual(Array(4).fill('not_run'));
        expect(w.cell.starts).toEqual([]);
        // Nothing built the PR a second time: no acquire on the fresh-host shard.
        expect(w.cell.acquires.some((a) => a.shard === 62)).toBe(false);
        const stored = await w.runs.results(ORG, 'sr-1');
        expect(stored.filter((r) => r.status === 'not_run').every((r) => r.errorSignature === 'PR image unavailable: push_failed')).toBe(true);
        expect(stored.some((r) => r.status === 'infra')).toBe(false);
    });
});
