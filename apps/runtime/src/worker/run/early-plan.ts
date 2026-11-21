import type { Claim } from '@libs/runtime/environment';

import type { AgentPlan } from '../agent/runtime-agent';
import type { RoundOut } from './replay';

// The agent plans from the diff and the base machine only (it explores the
// base, never the PR). On a heavy stack the base comes from the bake in
// seconds while the PR side builds for minutes (demo-twenty: base
// ready at 38 s, PR at 394 s, then 165 s of planning before the first probe).
// So the plan starts once the base is ready and the PR's build has started,
// and the PR's boot and the plan overlap.
//
// Durability: the plan is one step the workflow starts at a fixed place,
// right after the two first acquires, whatever their timing (DBOS: concurrent
// steps are valid "as long as the steps are started in a deterministic
// order"). Inside the step it waits for what it needs; a resumed workflow
// reads the recorded result and never plans again.
//
// Tokens: it never plans for a PR that has not started building (the fetch
// and the wait for room fail early), it is aborted as soon as the PR side is
// known not to boot, and a plan that finished but was never used is recorded
// on the Run (unusedPlan).
//
// The base ahead (review P1): a plan that ends while the PR still builds
// leaves the base machine idle, and the replay then plays each probe's two
// base rounds one after the other on it, the second alone. So, still inside
// the step, each probe's first base round is played (whileThePrBoots) until
// the PR side answers; the replay applies them as its base round 1 and starts
// with the base's second round beside the PR's first. The same reset, probe,
// stepId and evidence as the replay's own round 1, only earlier.

/** Each planned probe's first base round, played while the PR side built; the claim and image they ran on. */
export interface FirstBaseRounds {
    claimId: string;
    imageId: string;
    roundSnapshotId?: string;
    /** By probe index, from the first; a probe past the end was not played ahead. */
    rounds: RoundOut[];
}

/** What the step recorded: a plan, or why there is none (the Run then plans after the boot, as before). */
export type EarlyPlan =
    | { kind: 'planned'; plan: AgentPlan; firstBaseRounds?: FirstBaseRounds }
    | { kind: 'skipped'; why: 'base_not_ready' | 'pr_not_booted' | 'claim_lease' }
    | { kind: 'aborted' };

/** A side as its first acquire answered: its claim when it is ready, else nothing to plan on. */
export type FirstSide = { ready: Claim } | { ready?: undefined };

/** How often the PR's preparation is asked whether its build started. */
export const PR_BUILD_POLL_MS = 2_000;

export async function planWhileThePrBoots(args: {
    base: Promise<FirstSide>;
    pr: Promise<FirstSide>;
    /** Whether the PR side's build has started (the cell's `compose` phase); absent: the plan waits for the PR's claim. */
    prBuildStarted?: () => Promise<boolean>;
    /**
     * The lease check of the claims known when the plan starts: the base, and
     * the PR when its claim is already there (a recovered Run). false: a claim
     * is gone or compromised, and nothing is planned (the Run's own plan step
     * then says why, as before).
     */
    leasesHeld: (base: Claim, pr: Claim | undefined) => Promise<boolean>;
    plan: (base: Claim, signal: AbortSignal) => Promise<AgentPlan>;
    /**
     * Played once the plan is made, while the PR side has not answered
     * (prAnswered false): each probe's first base round. Absent: nothing ahead.
     */
    whileThePrBoots?: (plan: AgentPlan, base: Claim, prAnswered: () => boolean, signal: AbortSignal) => Promise<FirstBaseRounds | undefined>;
    signal: AbortSignal;
    pollMs?: number;
}): Promise<EarlyPlan> {
    const base = await args.base;
    if (!base.ready) return { kind: 'skipped', why: 'base_not_ready' };
    let pr: FirstSide | undefined;
    const prSettled = args.pr.then((p) => (pr = p));
    for (;;) {
        if (args.signal.aborted) return { kind: 'aborted' };
        if (pr) {
            if (!pr.ready) return { kind: 'skipped', why: 'pr_not_booted' };
            break;
        }
        if (!args.prBuildStarted) await Promise.race([prSettled, aborted(args.signal)]);
        else if (await args.prBuildStarted()) break;
        else await waitFor(args.pollMs ?? PR_BUILD_POLL_MS, Promise.race([prSettled, aborted(args.signal)]));
    }
    if (!(await args.leasesHeld(base.ready, pr?.ready))) return { kind: 'skipped', why: 'claim_lease' };
    let plan: AgentPlan;
    try {
        plan = await args.plan(base.ready, args.signal);
    } catch (e) {
        if (args.signal.aborted) return { kind: 'aborted' };
        throw e;
    }
    // A round that fails here is never the plan's loss: the replay plays it as before.
    const ahead = !pr && args.whileThePrBoots ? await args.whileThePrBoots(plan, base.ready, () => pr !== undefined, args.signal).catch(() => undefined) : undefined;
    return { kind: 'planned', plan, ...(ahead?.rounds.length ? { firstBaseRounds: ahead } : {}) };
}

/** Resolves when the signal aborts (never rejects). */
function aborted(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

/** Waits ms, or less when early settles; never leaves a timer behind. */
async function waitFor(ms: number, early: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), early]);
    clearTimeout(timer);
}
