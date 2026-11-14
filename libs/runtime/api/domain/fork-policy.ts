import {
    DEFAULT_FORK_PULL_REQUEST_POLICY,
    isForkPullRequestPolicy,
    type ForkPullRequestPolicy,
} from '@libs/runtime/contracts/enums';

import type { PullRequestHead } from './ports';

/** Why a fork PR got no Run; the trigger logs it and the web shows it. */
export const FORK_SKIPPED_REASON = 'fork_pull_requests_skipped';

export type ForkRunDecision =
    | { start: false; reason: typeof FORK_SKIPPED_REASON }
    | { start: true; fork: false }
    /** A fork Run: it waits for a maintainer when `approvalRequired`, and always runs on the fork budget. */
    | { start: true; fork: true; approvalRequired: boolean };

/** The environment's setting; absent or a value no policy names reads as the safe default. */
export function forkPolicyOf(setting: unknown): ForkPullRequestPolicy {
    return isForkPullRequestPolicy(setting) ? setting : DEFAULT_FORK_PULL_REQUEST_POLICY;
}

/**
 * Whether a PR's head may start a Run under the environment's fork policy
 * (ADR-030). `head.fork` comes from the Git API comparing the head and base
 * repository ids (ADR-057), never from the webhook; an unknown repo already
 * reads as a fork there.
 */
export function decideForkRun(setting: unknown, head: Pick<PullRequestHead, 'fork'>): ForkRunDecision {
    if (head.fork !== false) {
        const policy = forkPolicyOf(setting);
        if (policy === 'skip') return { start: false, reason: FORK_SKIPPED_REASON };
        return { start: true, fork: true, approvalRequired: policy !== 'run' };
    }
    return { start: true, fork: false };
}

/** A fork Run's LLM tokens: a quarter of the plan's per-Run budget, at least one. */
export const FORK_LLM_BUDGET_DIVISOR = 4;

export function forkRunMaxTokens(perRun: number): number {
    return Math.max(1, Math.floor(perRun / FORK_LLM_BUDGET_DIVISOR));
}
