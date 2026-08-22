import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SANDBOX_LEASE_CLEANUP_STATUS } from './schemas/sandbox-lease.model';
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

export const SANDBOX_LEASE_REPOSITORY_TOKEN = 'SANDBOX_LEASE_REPOSITORY_TOKEN';

@Injectable()
export class SandboxLeaseRepository {
    constructor(
        @InjectModel(SandboxLeaseModel.name)
        private readonly leaseModel: Model<SandboxLeaseModel>,
    ) {}

    /**
     * Atomically acquire (or join) a lease for the given prKey.
     *
     * Single findOneAndUpdate with BOTH operators in one update document:
     *   - $setOnInsert: sets initial state/timestamps on the INSERT path only
     *   - $inc: { leaseCount: 1 } increments the counter on BOTH insert and update paths
     *
     * On INSERT:  MongoDB applies $setOnInsert (state='CREATING', dates) and $inc
     *             (leaseCount 0→1). Returned doc has leaseCount === 1.
     * On UPDATE:  $setOnInsert is a no-op; $inc bumps leaseCount to N+1.
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

        const doc = await this.leaseModel.findOneAndUpdate(
            { _id: prKey },
            {
                $setOnInsert: {
                    state: 'CREATING',
                    createdAt: now,
                    expiresAt,
                    ...decomposed,
                },
                // Track the most recent consumer label so it's queryable in
                // Mongo without parsing logs. Updated on every acquire (both
                // insert and update paths).
                $set: consumer ? { consumer } : {},
                $inc: { leaseCount: 1 },
            },
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
     * Mark a CREATING or READY lease as INVALIDATED.
     *
     * CREATING: mid-create race handling — the create path detects this
     * after completing and kills the sandbox.
     * READY: called by invalidate() when a local READY lease has active
     * consumers (leaseCount > 0). The state change prevents new acquires
     * from attaching to the stale sandbox.
     */
    async markInvalidated(prKey: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: { $in: ['CREATING', 'READY'] } },
            { $set: { state: 'INVALIDATED' } },
        );
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
    ): Promise<Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'state'>[]> {
        return this.leaseModel
            .find({ expiresAt: { $lt: now } })
            .select('_id sandboxId state')
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
     * Atomically set the `killAt` timestamp on a lease document. Used by
     * release() to schedule an idle-kill that any worker (in a multi-worker
     * deployment) can pick up via findReadyToKill().
     *
     * Only sets killAt when the lease has a real sandboxId — there's no
     * point scheduling a kill for a NullSandbox or a CREATING-only lease.
     */
    async setKillAt(prKey: string, killAt: Date): Promise<void> {
        await this.leaseModel.updateOne(
            {
                _id: prKey,
                sandboxId: { $exists: true, $ne: '' },
            },
            { $set: { killAt } },
        );
    }

    /**
     * Atomically clear `killAt`. Called by acquire() when a new caller
     * joins before the idle window expires — keeps the warm sandbox alive
     * even if the worker that scheduled the kill is a different process.
     */
    async clearKillAt(prKey: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey },
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
    ): Promise<Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'killAt'>[]> {
        return this.leaseModel
            .find({
                killAt: { $lte: now },
                sandboxId: { $exists: true, $ne: '' },
            })
            .select('_id sandboxId killAt')
            .lean();
    }

    /**
     * Atomically claim a local cleanup. Returns the doc only when prKey and
     * sandboxId match and cleanup is not already in_progress or completed.
     *
     * @param requireLeaseCountZero When true, also requires leaseCount <= 0.
     *   Used by release/invalidate to prevent deleting a local sandbox
     *   directory while a concurrent acquire has re-incremented the lease
     *   count (race between decrementLease and claimCleanup). The reaper
     *   path passes false (default) because it force-reclaims regardless
     *   of active leases (expired TTL = all leases are dead).
     */
    async claimCleanup(
        prKey: string,
        expectedSandboxId: string,
        requireLeaseCountZero = false,
    ): Promise<SandboxLeaseModel | null> {
        const filter: Record<string, unknown> = {
            _id: prKey,
            sandboxId: expectedSandboxId,
            cleanupStatus: {
                $nin: [
                    SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
                    SANDBOX_LEASE_CLEANUP_STATUS.COMPLETED,
                ],
            },
        };
        if (requireLeaseCountZero) {
            filter.leaseCount = { $lte: 0 };
        }
        return this.leaseModel
            .findOneAndUpdate(
                filter,
                {
                    $set: {
                        cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
                        cleanupRetryAt: null,
                        cleanupStartedAt: new Date(),
                    },
                    $inc: { cleanupAttempts: 1 },
                },
                { new: true },
            )
            .exec();
    }

    /**
     * Complete a local cleanup by deleting the lease doc.
     * Only deletes when prKey, sandboxId, and cleanupStatus=IN_PROGRESS match.
     */
    async completeCleanup(
        prKey: string,
        expectedSandboxId: string,
    ): Promise<boolean> {
        const result = await this.leaseModel
            .deleteOne({
                _id: prKey,
                sandboxId: expectedSandboxId,
                cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
            })
            .exec();
        return result.deletedCount === 1;
    }

    /**
     * Mark a local cleanup as failed. Sets a retry marker.
     * Only updates when prKey, sandboxId, and cleanupStatus=IN_PROGRESS match.
     */
    async failCleanup(
        prKey: string,
        expectedSandboxId: string,
        error: string,
    ): Promise<boolean> {
        const result = await this.leaseModel
            .updateOne(
                {
                    _id: prKey,
                    sandboxId: expectedSandboxId,
                    cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
                },
                {
                    $set: {
                        cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.FAILED,
                        cleanupRetryAt: new Date(Date.now() + 60_000),
                        cleanupError: error.slice(0, 500),
                    },
                },
            )
            .exec();
        return result.modifiedCount === 1;
    }

    /**
     * Reset stale in_progress cleanup claims left behind by a crashed worker.
     * When a worker crashes after claiming cleanup (cleanupStatus=IN_PROGRESS)
     * but before completing it, the lease gets stuck forever — claimCleanup
     * rejects IN_PROGRESS docs. This method detects stale claims by checking
     * cleanupStartedAt against a threshold (typically 5 minutes) and resets
     * them to FAILED so the reaper can retry on the next tick.
     */
    async resetStaleCleanup(
        prKey: string,
        staleThreshold: Date,
    ): Promise<void> {
        await this.leaseModel
            .updateOne(
                {
                    _id: prKey,
                    cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
                    cleanupStartedAt: { $lt: staleThreshold },
                },
                {
                    $set: {
                        cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.FAILED,
                        cleanupError:
                            'Worker crash recovery — stale in_progress reset',
                    },
                },
            )
            .exec();
    }
}
