import type { PublishedCommentRef } from './runtime-publication';

// The Runtime keeps one comment per pull request, edited at every phase and
// at the result (screen 6). Publication keys are per message, so they cannot
// serialize two phases of the same PR delivered at once: the slot does. One
// row per (org, repo, PR) in the product's Postgres (`runtime_pr_comments`),
// held under a short lease while a delivery creates or edits the comment.

export const RUNTIME_PR_COMMENT_SLOT_STORE_TOKEN = Symbol.for(
    'RuntimePullRequestCommentSlotStore',
);

/** Long enough for one create or edit on the platform; a dead worker's lease expires on its own. */
export const COMMENT_SLOT_LEASE_MS = 2 * 60 * 1000;

export interface PullRequestRef {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    prNumber: number;
    /** Which environment's comment (publish-environment.ts): absent or '' for the one the repository is the primary of. */
    environmentKey?: string;
}

export interface PullRequestCommentSlot extends PullRequestRef {
    /** The platform ids of the PR comment, once created. */
    comment?: PublishedCommentRef;
    /** Highest order shown in the comment (see commentOrderOf); a lower one is stale. */
    commentOrder?: number;
    /**
     * A create was sent and its answer was not recorded (a crash, a lost
     * response). The next holder looks for the marked comment on the PR
     * before it creates another one.
     */
    createPending?: boolean;
    leaseOwner?: string;
    leaseUntil?: string;
    updatedAt: string;
}

export type CommentSlotPatch = Partial<
    Pick<PullRequestCommentSlot, 'comment' | 'commentOrder' | 'createPending'>
>;

export interface PullRequestCommentSlotStore {
    /** Takes the slot of this PR for `owner`, creating it on first use; null while another live lease holds it. */
    acquire(
        pr: PullRequestRef,
        owner: string,
        now?: Date,
    ): Promise<PullRequestCommentSlot | null>;
    /** Writes `patch` only while `owner` still holds the lease. */
    update(
        pr: PullRequestRef,
        owner: string,
        patch: CommentSlotPatch,
    ): Promise<void>;
    /** Drops the lease of `owner`; a lease taken over by someone else is left alone. */
    release(pr: PullRequestRef, owner: string): Promise<void>;
}

export function definedOnly<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined),
    ) as Partial<T>;
}
