import { type AcquireRequest, type ClaimProgress, FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { inMemoryRunDeps } from './testing';
import { runRuntimeRun } from './run-orchestrator';

// The base two rounds per probe are the replay's critical path on one base
// machine (review P1): the first beside the PR's, the second alone. When the
// plan is made while the PR still builds, the base machine is idle until the
// PR is ready; each probe's first base round is played then, and the replay
// starts with the base's second round beside the PR's first. Same rounds,
// same stepIds, same verdict; only earlier.

/** Waits until cond holds, failing after a while instead of hanging. */
async function until(cond: () => boolean, what: string) {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/** The shop environment; the PR side stays booting until the test lets it finish when slowPr is set. */
function shop(slowPr: boolean) {
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    const acquire = env.acquire.bind(env);
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    let prReady = false;
    env.acquire = async (r: AcquireRequest) => {
        if (r.ref.side === 'pr' && slowPr) await held;
        const claim = await acquire(r);
        if (r.ref.side === 'pr') prReady = true;
        return claim;
    };
    Object.assign(env, {
        progress: async (): Promise<ClaimProgress> => ({ phases: [{ phase: 'compose', state: 'started', at: new Date().toISOString() }], lines: [], updatedAt: new Date().toISOString() }),
    });
    const probed: Array<{ claimId: string; stepId: string; prReady: boolean }> = [];
    const probe = env.probe.bind(env);
    env.probe = async (claimId, p, stepId, evidence) => {
        probed.push({ claimId, stepId, prReady });
        return probe(claimId, p, stepId, evidence);
    };
    return { env, finish, probed };
}

describe("the base plays each probe's first round while the PR side builds", () => {
    it('plays the same rounds with the same stepIds and reaches the same verdict as a Run whose PR was ready first', async () => {
        const req = shopRunRequest();
        const seed = (h: ReturnType<typeof inMemoryRunDeps>) => h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });

        const fast = shop(false);
        const a = inMemoryRunDeps({ env: fast.env });
        await seed(a);
        const before = await runRuntimeRun(req, a.deps);

        const slow = shop(true);
        const b = inMemoryRunDeps({ env: slow.env });
        await seed(b);
        const running = runRuntimeRun(req, b.deps);
        // The plan is made and the base's first rounds are played while the PR has not answered.
        await until(() => b.logged.some((l: any) => l.msg === 'run.replay.base_ahead'), 'the base rounds ahead');
        const ahead = slow.probed.filter((p) => !p.prReady);
        slow.finish();
        const after = await running;

        expect(ahead.length).toBeGreaterThan(0);
        expect(after.state).toBe(before.state);
        expect((await b.projection.get(req.runId))!.probes!.map((p) => [p.probeId, p.verdict])).toEqual((await a.projection.get(req.runId))!.probes!.map((p) => [p.probeId, p.verdict]));
        // Every round once: the same stepIds as the Run that played them all in the replay.
        const ids = (probed: typeof fast.probed) => probed.map((p) => p.stepId).sort();
        expect(ids(slow.probed)).toEqual(ids(fast.probed));
    });

    it('plays nothing ahead when the PR side is ready before the plan is made', async () => {
        const req = shopRunRequest();
        const fast = shop(false);
        const h = inMemoryRunDeps({ env: fast.env });
        await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, h.deps);
        expect(fast.probed.every((p) => p.prReady)).toBe(true);
    });
});
