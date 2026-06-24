import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SandboxLeaseModel } from './schemas/sandbox-lease.model';
import {
    ISandboxLeaseRepository,
    SandboxLeaseLookup,
} from '@libs/sandbox/domain/contracts/sandbox-lease.repository.contract';

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
export class SandboxLeaseRepository implements ISandboxLeaseRepository {
    constructor(
        @InjectModel(SandboxLeaseModel.name)
        private readonly leaseModel: Model<SandboxLeaseModel>,
    ) {}

    /**
     * Atomically acquire (or join) a lease for the given prKey.
     *
     * Single findOneAndUpdate with BOTH operators in one update document:
     *   - $setOnInsert: sets initial state/timestamps on the INSERT path only
     *   - $set: refreshes expiresAt and consumer on BOTH insert and update paths
     *   - $inc: { leaseCount: 1 } increments the counter on BOTH insert and update paths
     *
     * On INSERT:  MongoDB applies $setOnInsert (state='CREATING', createdAt) and $inc
     *             (leaseCount 0→1). Returned doc has leaseCount === 1.
     * On UPDATE:  $setOnInsert is a no-op; $set refreshes expiresAt and $inc
     *             bumps leaseCount to N+1.
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
                    ...decomposed,
                },
                // Track the most recent consumer label and refresh the lease
                // expiry on every acquire. The expired-lease reaper uses this
                // timestamp as its atomic "not re-acquired" guard.
                $set: {
                    expiresAt,
                    ...(consumer ? { consumer } : {}),
                },
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
     * Mark a CREATING lease as INVALIDATED (mid-create race handling).
     * The create path will check for this state after completing and kill the sandbox.
     */
    async markInvalidated(prKey: string): Promise<void> {
        await this.leaseModel.updateOne(
            { _id: prKey, state: 'CREATING' },
            { $set: { state: 'INVALIDATED' } },
        );
    }

    /**
     * Find a lease document by its prKey (_id).
     */
    async findByPrKey(prKey: string): Promise<SandboxLeaseLookup | null> {
        return this.leaseModel
            .findOne({ _id: prKey })
            .select('_id state sandboxId')
            .lean<SandboxLeaseLookup>()
            .exec();
    }

    /**
     * Find a bounded batch of leases past their expiry date, plus any lease
     * already stuck in the transient DELETING state. Used by the reaper
     * regardless of leaseCount — crashed-worker leases stay at leaseCount > 0
     * forever, and cleanup/delete crashes leave DELETING docs behind.
     *
     * Read-only: projection keeps the response narrow and `.lean()` skips
     * Mongoose hydration since the reaper only reads the values, never
     * mutates the docs.
     */
    async findExpired(
        now: Date,
        limit?: number,
    ): Promise<Pick<SandboxLeaseModel, '_id' | 'sandboxId' | 'state'>[]> {
        const query = this.leaseModel
            .find({
                $or: [{ expiresAt: { $lt: now } }, { state: 'DELETING' }],
            })
            .sort({ expiresAt: 1 })
            .select('_id sandboxId state')
            .lean();

        if (limit !== undefined) {
            query.limit(limit);
        }

        return query;
    }

    /**
     * Delete a lease document by prKey. Used when the caller has already made
     * the lease non-reusable (for example invalidation, expired reaper cleanup,
     * or stale remote reconnect recovery). Normal local release/idle cleanup
     * uses deleteIfNoActiveLeases() instead.
     */
    async delete(prKey: string): Promise<void> {
        await this.leaseModel.deleteOne({ _id: prKey });
    }

    /**
     * Move an idle lease into a transient deleting state only when no active
     * leases remain. Local cleanup removes the worker-local directory first
     * and deletes the Mongo doc only after that succeeds, so failed rm attempts
     * can be retried by the expired reaper. E2B idle-kill uses the same state
     * to block warm reuse while the remote sandbox is being killed.
     */
    async markDeletingIfNoActiveLeases(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                leaseCount: { $lte: 0 },
            },
            {
                $set: { state: 'DELETING' },
                $unset: { killAt: '' },
            },
        );

        return result.matchedCount > 0;
    }

    /**
     * Move an expired lease into a transient deleting state only if no acquire
     * has renewed it since the reaper read the expired batch. Already-DELETING
     * docs are matched regardless of expiresAt so the reaper can recover from a
     * crash between cleanup and final delete. Unlike
     * markDeletingIfNoActiveLeases(), this intentionally allows leaseCount > 0:
     * those are the crashed-worker or over-TTL leases the expired reaper exists
     * to clean.
     */
    async markExpiredDeletingIfNotRenewed(
        prKey: string,
        expiredBefore: Date,
    ): Promise<boolean> {
        const result = await this.leaseModel.updateOne(
            {
                _id: prKey,
                $or: [
                    { expiresAt: { $lt: expiredBefore } },
                    { state: 'DELETING' },
                ],
            },
            {
                $set: { state: 'DELETING' },
                $unset: { killAt: '' },
            },
        );

        return result.matchedCount > 0;
    }

    /**
     * Delete a lease only when no active leases remain.
     *
     * Used after local sandbox directory cleanup. The lease count can be
     * incremented by a concurrent acquire after release()/idle-kill observes
     * leaseCount <= 0, so the final document delete must re-check the counter
     * atomically to avoid deleting a lease another caller just joined.
     */
    async deleteIfNoActiveLeases(prKey: string): Promise<boolean> {
        const result = await this.leaseModel.deleteOne({
            _id: prKey,
            leaseCount: { $lte: 0 },
        });

        return result.deletedCount > 0;
    }

    /**
     * Atomically set the `killAt` timestamp on a lease document only when
     * no active leases remain. Used by release() to schedule an idle-kill
     * that any worker (in a multi-worker deployment) can pick up via
     * findReadyToKill().
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

        return result.modifiedCount > 0;
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
}
