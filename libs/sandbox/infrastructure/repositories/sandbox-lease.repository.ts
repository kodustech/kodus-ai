import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SandboxLeaseModel } from './schemas/sandbox-lease.model';

/**
 * Decompose a prKey ("{orgId}:{repoId}:{prNumber}") into its parts.
 *
 * SECURITY: only accepts the canonical shape — a UUID organizationId in
 * segment 0 is required. Anything else throws so a bad prKey can't taint
 * the lease doc with the wrong organizationId. Caller is expected to have
 * already validated via assertValidPrKey() in the lease manager.
 */
const ORG_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decomposePrKey(prKey: string): {
    organizationId: string;
    repositoryId: string;
    prNumber?: string;
} {
    const parts = prKey.split(':');
    if (parts.length < 3 || parts.length > 4) {
        throw new Error(
            `decomposePrKey: invalid shape, expected 3 or 4 segments, got ${parts.length}`,
        );
    }
    // Accept the literal `'trial'` for public-demo / anonymous flows
    // (mirrors the relaxation in assertValidPrKey on the contract).
    if (parts[0] !== 'trial' && !ORG_UUID_RE.test(parts[0])) {
        throw new Error(
            `decomposePrKey: first segment must be a UUID organizationId or 'trial'`,
        );
    }
    // PR mode shape: <orgId>:<repoId>:<prNumber>
    if (parts.length === 3) {
        return {
            organizationId: parts[0],
            repositoryId: parts[1],
            prNumber: parts[2],
        };
    }
    // CLI mode shape: <orgId>:<repoId>:cli:<branch>
    return {
        organizationId: parts[0],
        repositoryId: parts[1],
    };
}

@Injectable()
export class SandboxLeaseRepository {
    constructor(
        @InjectModel(SandboxLeaseModel.name)
        private readonly leaseModel: Model<SandboxLeaseModel>,
    ) {}

    /**
     * Atomically acquire (or join) a lease for the given prKey.
     *
     * Single findOneAndUpdate with an aggregation pipeline:
     *   - Missing fields are initialized on the INSERT path only via $ifNull
     *   - leaseCount increments on BOTH insert and update paths
     *   - expiresAt refreshes on normal acquires but is preserved for DELETING
     *     leases so failed cleanup retry cursors are not postponed by user retries
     *
     * On INSERT:  MongoDB applies defaults (state='CREATING', dates) and increments
     *             leaseCount 0→1. Returned doc has leaseCount === 1.
     * On UPDATE:  Existing defaults are preserved; leaseCount bumps to N+1.
     *
     * Caller identifies itself as creator when doc.leaseCount === 1.
     * Caller must poll when doc.leaseCount > 1 and doc.state === 'CREATING'.
     *
     * CRITICAL: Do NOT split into find + update — atomicity required (Pitfall 2).
     * Do NOT add a separate incrementLease() — this method handles both paths.
     */
    async upsertAcquire(
        prKey: string,
        leaseTtlMs: number,
        consumer?: string,
    ): Promise<SandboxLeaseModel> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + leaseTtlMs);
        const decomposed = decomposePrKey(prKey);

        const setStage: Record<string, unknown> = {
            state: { $ifNull: ['$state', 'CREATING'] },
            createdAt: { $ifNull: ['$createdAt', now] },
            organizationId: {
                $ifNull: ['$organizationId', decomposed.organizationId],
            },
            repositoryId: {
                $ifNull: ['$repositoryId', decomposed.repositoryId],
            },
            expiresAt: {
                $cond: [
                    { $eq: ['$state', 'DELETING'] },
                    '$expiresAt',
                    expiresAt,
                ],
            },
            leaseCount: { $add: [{ $ifNull: ['$leaseCount', 0] }, 1] },
        };

        if (decomposed.prNumber !== undefined) {
            setStage.prNumber = { $ifNull: ['$prNumber', decomposed.prNumber] };
        }

        if (consumer) {
            setStage.consumer = consumer;
        }

        const doc = await this.leaseModel.findOneAndUpdate(
            { _id: prKey },
            [{ $set: setStage }],
            { upsert: true, new: true },
        );

        return doc;
    }

    /**
     * Atomically decrement leaseCount by 1. Returns the updated document
     * (which may have leaseCount === 0 after the decrement).
     */
    async decrementLease(prKey: string): Promise<SandboxLeaseModel | null> {
        return this.leaseModel.findOneAndUpdate(
            { _id: prKey },
            { $inc: { leaseCount: -1 } },
            { new: true },
        );
    }

    /**
     * Transition a CREATING lease to READY and record the sandboxId.
     * Only updates if the document is still in CREATING state to prevent
     * overwriting a concurrent INVALIDATED state change.
     */
    async updateReady(prKey: string, sandboxId: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: 'CREATING' },
            { $set: { state: 'READY', sandboxId } },
        );
    }

    /**
     * Mark a CREATING lease as INVALIDATED (mid-create race handling).
     * The create path will check for this state after completing and kill the sandbox.
     */
    async markInvalidated(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            { _id: prKey, state: { $in: ['READY', 'PAUSED'] } },
            { $set: { state: 'INVALIDATED' } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Mark a lease INVALIDATED only while it is still CREATING.
     * Used by invalidate() to avoid overwriting a concurrent CREATING→READY
     * transition with INVALIDATED after a sandbox has already become usable.
     */
    async markInvalidatedIfCreating(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            { _id: prKey, state: 'CREATING' },
            { $set: { state: 'INVALIDATED' } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Find a lease document by its prKey (_id).
     */
    async findByPrKey(prKey: string): Promise<SandboxLeaseModel | null> {
        return this.leaseModel.findOne({ _id: prKey });
    }

    /**
     * Find all leases past their expiry date. Used by the reaper regardless
     * of leaseCount — crashed-worker leases stay at leaseCount > 0 forever.
     *
     * Read-only: projection keeps the response narrow and `.lean()` skips
     * Mongoose hydration since the reaper only reads the values, never
     * mutates the docs.
     */
    async findExpired(
        now: Date,
        limit: number,
    ): Promise<
        Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'state' | 'expiresAt'>[]
    > {
        return this.leaseModel
            .find({ expiresAt: { $lt: now } })
            .select('_id sandboxId state expiresAt')
            .limit(limit)
            .lean();
    }

    /**
     * Delete a lease document by prKey. Called by invalidate() after soft-drain
     * and by the reaper after killing the E2B sandbox.
     */
    async delete(prKey: string): Promise<void> {
        await this.leaseModel.deleteOne({ _id: prKey });
    }

    /**
     * Delete a lease only when no active leases remain.
     *
     * Local sandbox cleanup and idle reapers can observe leaseCount <= 0 and
     * then race with a concurrent acquire. The final delete must re-check the
     * counter atomically so it never removes a lease another caller just joined.
     */
    async deleteIfNoActiveLeases(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.deleteOne({
            _id: prKey,
            leaseCount: { $lte: 0 },
        });

        return result.deletedCount > 0;
    }

    /**
     * Atomically block reuse before resource cleanup.
     *
     * Local directories must not be removed while a concurrent acquire can
     * still warm-reuse the READY lease. Marking DELETING first makes joiners
     * wait/retry instead of connecting to a directory being deleted.
     */
    async markDeletingIfNoActiveLeases(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                leaseCount: { $lte: 0 },
                state: { $in: ['READY', 'PAUSED', 'INVALIDATED', 'DELETING'] },
            },
            { $set: { state: 'DELETING' } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Atomically claim an idle-kill candidate before resource cleanup.
     *
     * The reaper reads candidates first, then cleanup can race with a fresh
     * acquire that increments leaseCount and clears killAt. This guard
     * re-checks both values before switching the lease to DELETING.
     */
    async markDeletingIfReadyToKill(
        prKey: string,
        killAt: Date,
    ): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                killAt,
                leaseCount: { $lte: 0 },
                sandboxId: { $exists: true, $ne: '' },
                state: { $in: ['READY', 'PAUSED', 'DELETING'] },
            },
            { $set: { state: 'DELETING' } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Atomically claim an expired lease before resource cleanup.
     *
     * Expired leases may still have leaseCount > 0 when a worker crashed before
     * releasing. Matching the original expiresAt lets a fresh acquire extend
     * the TTL and make this claim fail before the reaper removes anything.
     */
    async markDeletingIfExpired(
        prKey: string,
        expiresAt: Date,
    ): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                expiresAt,
                state: {
                    $in: [
                        'CREATING',
                        'READY',
                        'PAUSED',
                        'INVALIDATED',
                        'DELETING',
                    ],
                },
            },
            { $set: { state: 'DELETING' } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Atomically set the `killAt` timestamp on a lease document. Used by
     * release() to schedule an idle-kill that any worker (in a multi-worker
     * deployment) can pick up via findReadyToKill().
     *
     * Only sets killAt when the lease has a real sandboxId — there's no
     * point scheduling a kill for a NullSandbox or a CREATING-only lease.
     */
    async setKillAt(prKey: string, killAt: Date): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                leaseCount: { $lte: 0 },
                sandboxId: { $exists: true, $ne: '' },
            },
            { $set: { killAt } },
        );

        return result.matchedCount > 0;
    }

    /**
     * Atomically clear `killAt`. Called by acquire() when a new caller
     * joins before the idle window expires — keeps the warm sandbox alive
     * even if the worker that scheduled the kill is a different process.
     */
    async clearKillAt(prKey: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: { $ne: 'DELETING' } },
            { $unset: { killAt: '' } },
        );
    }

    /**
     * Find leases whose idle-kill timestamp has elapsed. Drives the
     * `killIdleSandboxes` cron — runs against the sparse compound index
     * `{ killAt: 1, sandboxId: 1 }` so it only scans docs that are actually
     * waiting to be killed.
     *
     * Read-only: projection + `.lean()` since the cron only reads the
     * values to issue the kill, never writes back through the Mongoose doc.
     */
    async findReadyToKill(
        now: Date,
        limit: number,
    ): Promise<Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'killAt'>[]> {
        return this.leaseModel
            .find({
                killAt: { $lte: now },
                sandboxId: { $exists: true, $ne: '' },
            })
            .select('_id sandboxId killAt')
            .limit(limit)
            .lean();
    }
}
