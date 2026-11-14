import { isBlocked } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { inMemoryRunDeps } from './in-memory-deps';
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
});
