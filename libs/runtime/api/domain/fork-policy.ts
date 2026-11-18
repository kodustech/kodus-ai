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
 * Whether a fork Run may start without a maintainer in an environment of
 * that many repositories: only in one of a single repository. A Run's machine
 * holds the code of every repository of its environment, so a fork's code
 * would run next to every member's.
 */
export function forkMayRunUnheld(repositoryCount: number): boolean {
    return repositoryCount <= 1;
}

/**
 * The fork policy that applies to the environment: its own, except that
 * `run` reads as `require_approval` once it holds several repositories.
 */
export function effectiveForkPolicy(setting: unknown, repositoryCount: number): ForkPullRequestPolicy {
    const policy = forkPolicyOf(setting);
    return policy === 'run' && !forkMayRunUnheld(repositoryCount) ? 'require_approval' : policy;
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
