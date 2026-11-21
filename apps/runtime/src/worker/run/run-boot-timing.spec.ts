import { FakeEnvironmentRuntime, isBlocked } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';

import { shopRunRequest } from '../../e2e/fixtures';
import { inMemoryRunDeps } from './testing';
import { runRuntimeRun } from './run-orchestrator';

// The Run keeps each side's claim.ready.timing next to its bootMs, so the
// product can show where the boot went (build, up, seed, ready).

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>) =>
    projection.upsert(req.runId, {
        attempt: req.attempt,
        correlationId: req.correlationId,
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        state: 'queued',
        requestedAt: req.requestedAt,
    });

describe('the boot timing of a Run', () => {
    it('keeps each side’s claim.ready.timing on the projection with bootMs', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const timing = { base: { prepareMs: 4_000, bootMs: 3_500, upMs: 3_000 }, pr: { prepareMs: 6_000, bootMs: 5_500, buildMs: 2_000, upMs: 3_000 } };
        const acquire = deps.env.acquire.bind(deps.env);
        deps.env.acquire = async (r) => {
            const c = await acquire(r);
            return isBlocked(c) ? c : { ...c, timing: timing[r.ref.side as 'base' | 'pr'] };
        };
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const run = await projection.get(req.runId);
        expect(run!.bootMs).toEqual(expect.any(Number));
        expect(run!.bootTiming).toEqual(timing);
    });

    it('a cell that sends no timing leaves bootTiming absent, not empty', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const run = await projection.get(req.runId);
        expect(run!.bootMs).toEqual(expect.any(Number));
        expect(run).not.toHaveProperty('bootTiming');
        expect(run).not.toHaveProperty('buildSteps');
    });

    it('keeps where each side’s builds spent their time apart from the phases, and run.finished says which, without the step names', async () => {
        const { deps, projection, logged } = inMemoryRunDeps();
        const prSteps = {
            steps: 14,
            done: 9,
            cached: 5,
            errored: 0,
            slowest: [
                { service: 'grafana', name: '[build 5/6] RUN GITHUB_TOKEN=ghp_EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0EXAM go build ./pkg/cmd/grafana', ms: 380_200 },
                { service: 'grafana', name: '[internal] load build context', ms: 44_100 },
            ],
        };
        // An older cell (or hub) sends the base without steps.
        const timing = { base: { prepareMs: 50_000, buildMs: 40_000 }, pr: { prepareMs: 462_000, buildMs: 450_000, buildSteps: prSteps } };
        const acquire = deps.env.acquire.bind(deps.env);
        deps.env.acquire = async (r) => {
            const c = await acquire(r);
            return isBlocked(c) ? c : { ...c, timing: timing[r.ref.side as 'base' | 'pr'] };
        };
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const run = await projection.get(req.runId);
        expect(run!.bootTiming).toEqual({ base: timing.base, pr: { prepareMs: 462_000, buildMs: 450_000 } });
        expect(run!.buildSteps).toEqual([
            {
                side: 'pr',
                steps: 14,
                done: 9,
                cached: 5,
                errored: 0,
                slowest: [
                    { service: 'grafana', name: '[build 5/6] RUN GITHUB_TOKEN=[redacted:github-pat] go build ./pkg/cmd/grafana', ms: 380_200 },
                    { service: 'grafana', name: '[internal] load build context', ms: 44_100 },
                ],
            },
        ]);
        const finished = logged.find((l) => l.msg === 'run.finished')!;
        expect(finished).toMatchObject({
            buildSteps: 14,
            buildCached: 5,
            slowestBuildSteps: [
                { side: 'pr', service: 'grafana', ms: 380_200 },
                { side: 'pr', service: 'grafana', ms: 44_100 },
            ],
        });
        expect(JSON.stringify(logged)).not.toContain('go build');
    });
    // demo-calcom#2: the PR's build ran cold for 30 min and the cell answered boot_timeout;
    // the comment said "Booted in 30m" above "the machine ran out of resources".
    it.each(['pr', 'base'] as const)('a Run whose %s side never booted publishes no boot time', async (side) => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) =>
            r.ref.side === side ? { status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 30 min, the most a setup waits' }] } : acquire(r);
        const { deps, projection, published } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const reports = published.filter((p) => p.report).map((p) => p.report!);
        expect(reports.length).toBeGreaterThan(0);
        expect(reports.map((r) => r.bootMs)).toEqual(reports.map(() => undefined));
        expect((await projection.get(req.runId))!.bootMs).toBeUndefined();
    });

    // The same Run: the cell had evicted the environment's build state at 07:31, so the PR built cold. The report
    // said "the machine ran out of resources" and nothing told the owner a new setup brings the cache back.
    it('a PR side that timed out building on an evicted state names that cause, and the report says it built with no cache', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        const evictedAt = '2026-11-13T07:31:31.000Z';
        env.acquire = async (r) =>
            r.ref.side === 'pr'
                ? { status: 'blocked', buildStateEvictedAt: evictedAt, blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 30 min, the most a boot of this claim waits' }] }
                : acquire(r);
        const { deps, projection, published } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const report = published.filter((p) => p.report).at(-1)!.report!;
        expect(report.state).toBe('partly_tested');
        expect(report.coldBuild).toEqual({ side: 'pr', cause: 'build_state_evicted', evictedAt });
        expect(report.uncovered.length).toBeGreaterThan(0);
        expect(report.uncovered.every((u) => u.blocker?.kind === 'resources' && u.blocker.cause === 'build_state_evicted')).toBe(true);
    });

    it('a base boot_timeout with its state in place is named a timeout, not a machine out of resources', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) =>
            r.ref.side === 'base' ? { status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 30 min' }] } : acquire(r);
        const { deps, projection, published } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const report = published.filter((p) => p.report).at(-1)!.report!;
        expect(report.coldBuild).toBeUndefined();
        expect(report.uncovered.length).toBeGreaterThan(0);
        expect(report.uncovered.every((u) => u.blocker?.cause === 'boot_timeout')).toBe(true);
    });

    // S1-01: the PR's code decides how long its boot takes; with its build state in place nothing outside it slowed it.
    it('a PR side that outlived its wait with its build state in place, while the base booted, is a regression', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) =>
            r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 30 min' }] } : acquire(r);
        const { deps, projection } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'regression' });
    });

    it('a side that booted after building on an evicted state still says it built with no cache', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const acquire = deps.env.acquire.bind(deps.env);
        const evictedAt = '2026-11-13T07:31:31.000Z';
        deps.env.acquire = async (r) => {
            const c = await acquire(r);
            return isBlocked(c) || r.ref.side !== 'pr' ? c : { ...c, buildStateEvictedAt: evictedAt };
        };
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        expect((await projection.get(req.runId))!.coldBuild).toEqual({ side: 'pr', cause: 'build_state_evicted', evictedAt });
        expect(published.filter((p) => p.report).at(-1)!.report!.coldBuild).toEqual({ side: 'pr', cause: 'build_state_evicted', evictedAt });
    });
});
