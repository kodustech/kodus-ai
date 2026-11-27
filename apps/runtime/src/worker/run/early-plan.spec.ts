import { FakeEnvironmentRuntime, type AcquireRequest, type ClaimProgress } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { inMemoryRunDeps } from './testing';
import { runRuntimeRun } from './run-orchestrator';
import { withSpentTokens } from '../agent/runtime-agent';
import { planWhileThePrBoots } from './early-plan';

/** Waits until cond holds, failing after a while instead of hanging. */
async function until(cond: () => boolean, what: string) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * The shop environment with a PR side that stays booting until the test lets
 * it finish, and a claim.progress that says whether its build started.
 */
function slowPr(opts: { buildStarted: boolean; prBlocked?: boolean }) {
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    const acquire = env.acquire.bind(env);
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    let prDone = false;
    env.acquire = async (r: AcquireRequest) => {
        if (r.ref.side !== 'pr') return acquire(r);
        await held;
        prDone = true;
        if (opts.prBlocked) return { status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'node-24', message: 'x' }] } as never;
        return acquire(r);
    };
    const progress = jest.fn(
        async (): Promise<ClaimProgress> => ({
            phases: [
                { phase: 'fetch', state: 'done', at: new Date().toISOString() },
                ...(opts.buildStarted ? [{ phase: 'compose', state: 'started' as const, at: new Date().toISOString() }] : []),
            ],
            lines: [],
            updatedAt: new Date().toISOString(),
        }),
    );
    Object.assign(env, { progress });
    return { env, finish, prDone: () => prDone, progress };
}

describe('the agent plans while the PR side boots', () => {
    it("plans once the base is ready and the PR's build has started, before the PR side is ready", async () => {
        const pr = slowPr({ buildStarted: true });
        const h = inMemoryRunDeps({ env: pr.env });
        const plan = jest.spyOn(h.deps.agent, 'plan');
        const req = shopRunRequest();
        const running = runRuntimeRun(req, h.deps);
        await until(() => plan.mock.calls.length > 0, 'the plan');
        expect(pr.prDone()).toBe(false);
        pr.finish();
        // The same Run as one that planned after the boot: the regression on POST /orders.
        expect(await running).toMatchObject({ state: 'regression' });
        expect(plan).toHaveBeenCalledTimes(1);
    });

    it("never plans while the PR side has not started building, and plans once it is ready", async () => {
        const pr = slowPr({ buildStarted: false });
        const h = inMemoryRunDeps({ env: pr.env });
        const plan = jest.spyOn(h.deps.agent, 'plan');
        const running = runRuntimeRun(shopRunRequest(), h.deps);
        await until(() => pr.progress.mock.calls.length > 0, 'the PR side to be asked');
        await new Promise((r) => setTimeout(r, 50));
        expect(plan).not.toHaveBeenCalled();
        pr.finish();
        expect(await running).toMatchObject({ state: 'regression' });
        expect(plan).toHaveBeenCalledTimes(1);
    });

    it('a PR side that does not boot after the agent planned leaves the plan unused, with its tokens on the Run', async () => {
        const pr = slowPr({ buildStarted: true, prBlocked: true });
        const h = inMemoryRunDeps({ env: pr.env });
        const plan = jest.spyOn(h.deps.agent, 'plan');
        const req = shopRunRequest();
        const running = runRuntimeRun(req, h.deps);
        await until(() => plan.mock.results.length > 0 && plan.mock.results[0].type === 'return', 'the plan');
        await plan.mock.results[0].value;
        pr.finish();
        expect(await running).toMatchObject({ state: 'regression' });
        const run = (await h.projection.get(req.runId))!;
        expect(run.findings?.[0].findingKind).toBe('pr_destabilizes_machine');
        expect(run.unusedPlan).toBeDefined();
        expect(run.unusedPlan!.inputTokens + run.unusedPlan!.outputTokens).toBeGreaterThan(0);
        expect(h.logged.some((l: any) => l.msg === 'run.plan.unused')).toBe(true);
    });
});

describe('a plan stopped while the PR boots', () => {
    // Behavior: the rounds that answered before the stop were paid for, so the stop reports them instead of reading as free.
    it('reports the tokens of the rounds that had answered when it was stopped', async () => {
        const abort = new AbortController();
        const claim = { claimId: 'c1' } as never;
        const result = await planWhileThePrBoots({
            base: Promise.resolve({ ready: claim }),
            pr: new Promise(() => undefined),
            prBuildStarted: async () => true,
            leasesHeld: async () => true,
            plan: async () => {
                abort.abort();
                throw withSpentTokens(new Error('aborted'), { inputTokens: 40_000, outputTokens: 5_000 });
            },
            signal: abort.signal,
        });
        expect(result).toEqual({ kind: 'aborted', spent: { inputTokens: 40_000, outputTokens: 5_000 } });
    });

    it('stays a plain stop when no round had answered', async () => {
        const abort = new AbortController();
        const result = await planWhileThePrBoots({
            base: Promise.resolve({ ready: { claimId: 'c1' } as never }),
            pr: new Promise(() => undefined),
            prBuildStarted: async () => true,
            leasesHeld: async () => true,
            plan: async () => {
                abort.abort();
                throw new Error('aborted');
            },
            signal: abort.signal,
        });
        expect(result).toEqual({ kind: 'aborted' });
    });
});
