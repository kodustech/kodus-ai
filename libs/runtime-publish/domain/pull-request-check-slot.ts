import type { RuntimePublishRequested } from '@libs/runtime/run';

// Two Runs on one head share one check: GitHub's check run of that name on
// the head (findCheckRun), a commit status of that context, Forgejo's status.
// Publication keys are per Run, so nothing ordered them: a late fallback or
// redrive of an older Run moved the check a newer Run had closed
// (v-product V-02, r5 P5). The slot keeps, per (org, repo, head, check
// name), the order of the last check published there, and a short lease
// while a delivery writes it, as the comment slot does for the comment.
// One row per key in the product's Postgres (`runtime_pr_checks`).

export const RUNTIME_PR_CHECK_SLOT_STORE_TOKEN = Symbol.for('RuntimePullRequestCheckSlotStore');

/** Long enough for one create or update of a check on the platform; a dead worker's lease expires on its own. */
export const CHECK_SLOT_LEASE_MS = 2 * 60 * 1000;

export interface PullRequestCheckRef {
    organizationId: string;
    repositoryId: string;
    headSha: string;
    /** The check's name on the platform (publish-environment.ts checkNameOf): one per environment. */
    checkName: string;
}

export interface PullRequestCheckSlot extends PullRequestCheckRef {
    /** The order of the last check published here (checkOrderOf); a lower one is stale. */
    checkOrder?: number;
    leaseOwner?: string;
    leaseUntil?: string;
    updatedAt: string;
}

export interface PullRequestCheckSlotStore {
    /** Takes the slot for `owner`, creating it on first use; null while another live lease holds it. */
    acquire(ref: PullRequestCheckRef, owner: string, now?: Date): Promise<PullRequestCheckSlot | null>;
    /** Records the order published, only while `owner` holds the lease and never lowering it. */
    recordOrder(ref: PullRequestCheckRef, owner: string, order: number): Promise<void>;
    /** Drops the lease of `owner`; a lease taken over by someone else is left alone. */
    release(ref: PullRequestCheckRef, owner: string): Promise<void>;
}

/**
 * Order of a check: the Run's request time in ms, then its phase (1 waiting
 * for a maintainer, 9 the verdict), as one number. A check never overwrites
 * one of a later Run; the same Run's own deliveries, its fallback and its
 * redrive share their order. Undefined: the message carries no report, so
 * nothing orders it (the shape check refuses such a final check).
 */
export function checkOrderOf(msg: Pick<RuntimePublishRequested, 'check' | 'report'>, final: boolean): number | undefined {
    const at = msg.report ? Date.parse(msg.report.requestedAt) : NaN;
    if (!Number.isFinite(at)) return undefined;
    return at * 10 + (final ? 9 : 1);
}
