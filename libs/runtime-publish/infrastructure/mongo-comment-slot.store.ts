import type { Collection, Filter } from 'mongodb';

import {
    COMMENT_SLOT_LEASE_MS,
    definedOnly,
    type CommentSlotPatch,
    type PullRequestCommentSlot,
    type PullRequestCommentSlotStore,
    type PullRequestRef,
} from '../domain/pull-request-comment-slot';

const DUPLICATE_KEY = 11000;

/** `runtime_pr_comments` in the product's Mongo: one row per (org, repo, PR), unique. */
export class MongoCommentSlotStore implements PullRequestCommentSlotStore {
    constructor(private readonly collection: Collection<PullRequestCommentSlot>) {}

    /** The unique PR key is what lets only one delivery hold a PR's comment. */
    static async ensureIndexes(collection: Collection<PullRequestCommentSlot>) {
        await collection.createIndex(
            { organizationId: 1, repositoryId: 1, prNumber: 1 },
            { unique: true, name: 'pr_comment_slot' },
        );
    }

    async acquire(
        pr: PullRequestRef,
        owner: string,
        now = new Date(),
    ): Promise<PullRequestCommentSlot | null> {
        const nowIso = now.toISOString();
        const filter: Filter<PullRequestCommentSlot> = {
            ...prFilter(pr),
            $or: [
                { leaseUntil: { $exists: false } },
                { leaseUntil: null as any },
                { leaseUntil: { $lte: nowIso } },
            ],
        };
        try {
            // A live lease fails the filter; the upsert then hits the unique
            // PR key and the duplicate-key error is "busy".
            const slot = await this.collection.findOneAndUpdate(
                filter,
                {
                    $set: {
                        teamId: pr.teamId,
                        leaseOwner: owner,
                        leaseUntil: new Date(
                            now.getTime() + COMMENT_SLOT_LEASE_MS,
                        ).toISOString(),
                        updatedAt: nowIso,
                    },
                },
                { upsert: true, returnDocument: 'after', projection: { _id: 0 } },
            );
            return (slot as PullRequestCommentSlot | null) ?? null;
        } catch (error) {
            if ((error as { code?: number })?.code === DUPLICATE_KEY) return null;
            throw error;
        }
    }

    async update(pr: PullRequestRef, owner: string, patch: CommentSlotPatch) {
        const { createPending, ...rest } = patch;
        await this.collection.updateOne(
            { ...prFilter(pr), leaseOwner: owner },
            {
                $set: {
                    ...definedOnly(rest),
                    ...(createPending ? { createPending: true } : {}),
                    updatedAt: new Date().toISOString(),
                },
                ...(createPending === false
                    ? { $unset: { createPending: '' } }
                    : {}),
            },
        );
    }

    async release(pr: PullRequestRef, owner: string) {
        await this.collection.updateOne(
            { ...prFilter(pr), leaseOwner: owner },
            { $unset: { leaseOwner: '', leaseUntil: '' } },
        );
    }
}

const prFilter = (pr: PullRequestRef) => ({
    organizationId: pr.organizationId,
    repositoryId: pr.repositoryId,
    prNumber: pr.prNumber,
});
