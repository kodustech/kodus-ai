import type { PublishedCommentRef } from './runtime-publication';

// The Runtime keeps one comment per pull request, edited at every phase and
// at the result (screen 6). Publication keys are per message, so they cannot
// serialize two phases of the same PR delivered at once: the slot does. One
// row per (org, repo, PR) in the product's Mongo (`runtime_pr_comments`),
// held under a short lease while a delivery creates or edits the comment.

export const RUNTIME_PR_COMMENTS_COLLECTION = 'runtime_pr_comments';
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

const slotKey = (pr: PullRequestRef) =>
    `${pr.organizationId}/${pr.repositoryId}/${pr.prNumber}`;

export class InMemoryCommentSlotStore implements PullRequestCommentSlotStore {
    readonly rows = new Map<string, PullRequestCommentSlot>();

    async acquire(pr: PullRequestRef, owner: string, now = new Date()) {
        const key = slotKey(pr);
        const existing = this.rows.get(key);
        if (
            existing?.leaseUntil &&
            Date.parse(existing.leaseUntil) > now.getTime()
        ) {
            return null;
        }
        const slot: PullRequestCommentSlot = {
            ...(existing ?? pr),
            leaseOwner: owner,
            leaseUntil: new Date(
                now.getTime() + COMMENT_SLOT_LEASE_MS,
            ).toISOString(),
            updatedAt: now.toISOString(),
        };
        this.rows.set(key, slot);
        return { ...slot };
    }

    async update(pr: PullRequestRef, owner: string, patch: CommentSlotPatch) {
        const key = slotKey(pr);
        const row = this.rows.get(key);
        if (!row || row.leaseOwner !== owner) return;
        const next: PullRequestCommentSlot = {
            ...row,
            ...definedOnly(patch),
            updatedAt: new Date().toISOString(),
        };
        if (patch.createPending === false) delete next.createPending;
        this.rows.set(key, next);
    }

    async release(pr: PullRequestRef, owner: string) {
        const key = slotKey(pr);
        const row = this.rows.get(key);
        if (!row || row.leaseOwner !== owner) return;
        const { leaseOwner: _o, leaseUntil: _u, ...rest } = row;
        this.rows.set(key, rest);
    }
}

export function definedOnly<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined),
    ) as Partial<T>;
}
