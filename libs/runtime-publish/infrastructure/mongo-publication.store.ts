import type { Collection, Filter } from 'mongodb';

import { definedOnly } from '../domain/pull-request-comment-slot';
import {
    PUBLICATION_LEASE_MS,
    refusalState,
    type ClaimRequest,
    type ClaimResult,
    type PublicationReader,
    type PublicationRedriveStore,
    type PublicationResult,
    type PublicationRetryState,
    type PublicationStore,
    type RuntimePublication,
} from '../domain/runtime-publication';

const DUPLICATE_KEY = 11000;

/** A Run publishes a check, a comment per phase and a reply per confirmed suggestion: far below this. */
const MAX_ROWS_PER_RUN = 50;

/** `runtime_publications` in the product's Mongo: one row per `runId:attempt:kind`. */
export class MongoPublicationStore
    implements PublicationStore, PublicationRedriveStore
{
    constructor(private readonly collection: Collection<RuntimePublication>) {}

    /** The unique key is what makes a claim atomic: the module does not start without it. */
    static async ensureIndexes(collection: Collection<RuntimePublication>) {
        await collection.createIndex(
            { key: 1 },
            { unique: true, name: 'publication_key' },
        );
        // The Run page reads a Run's rows; the redrive sweeper scans stale ones.
        await collection.createIndex(
            { organizationId: 1, runId: 1 },
            { name: 'publication_run' },
        );
        await collection.createIndex(
            { status: 1, updatedAt: 1 },
            { name: 'publication_redrive' },
        );
    }

    async claim(request: ClaimRequest, now = new Date()): Promise<ClaimResult> {
        const nowIso = now.toISOString();
        const leaseUntil = new Date(
            now.getTime() + PUBLICATION_LEASE_MS,
        ).toISOString();

        // Same rule as canClaim(), as one atomic filter.
        const takeable: Filter<RuntimePublication>[] = [
            { status: 'failed' },
            { status: 'publishing', leaseUntil: { $lte: nowIso } },
        ];
        if (request.kind === 'check') {
            takeable.push({ status: 'published' });
        }
        const filter: Filter<RuntimePublication> = {
            key: request.key,
            $or: takeable,
        };
        if (request.kind === 'check') {
            filter.$and = [
                {
                    $or: [
                        { checkRank: { $exists: false } },
                        { checkRank: null as any },
                        { checkRank: { $lt: request.checkRank ?? 0 } },
                    ],
                },
            ];
        }

        const taken = await this.collection.findOneAndUpdate(
            filter,
            {
                $set: {
                    status: 'publishing',
                    leaseUntil,
                    updatedAt: nowIso,
                    ...(request.request ? { request: request.request } : {}),
                },
            },
            { returnDocument: 'after', projection: { _id: 0 } },
        );
        if (taken) {
            return {
                state: 'claimed',
                publication: taken as RuntimePublication,
            };
        }

        const { checkRank: _rank, ...fields } = request;
        const fresh: RuntimePublication = {
            ...fields,
            status: 'publishing',
            leaseUntil,
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        try {
            await this.collection.insertOne({ ...fresh });
            return { state: 'claimed', publication: fresh };
        } catch (error) {
            if ((error as { code?: number })?.code !== DUPLICATE_KEY) {
                throw error;
            }
        }

        const existing = await this.collection.findOne(
            { key: request.key },
            { projection: { _id: 0 } },
        );
        if (!existing) {
            // Deleted between the insert and the read: let the broker retry.
            return { state: 'busy', publication: fresh };
        }
        return {
            state: refusalState(existing as RuntimePublication, now),
            publication: existing as RuntimePublication,
        };
    }

    async complete(key: string, result: PublicationResult) {
        await this.collection.updateOne(
            { key },
            {
                $set: {
                    ...definedOnly(result),
                    updatedAt: new Date().toISOString(),
                },
                $unset: { leaseUntil: '' },
            },
        );
    }

    async release(key: string, reason: string, keep?: PublicationRetryState) {
        await this.collection.updateOne(
            { key },
            {
                $set: {
                    ...definedOnly(keep ?? {}),
                    status: 'failed',
                    reason,
                    updatedAt: new Date().toISOString(),
                },
                $unset: { leaseUntil: '' },
            },
        );
    }

    /** Same rule as isStaleForRedrive(). */
    async findStale(staleBefore: string, now: string, limit: number) {
        return (await this.collection
            .find(
                {
                    $or: [
                        { status: 'failed' },
                        { status: 'publishing', leaseUntil: { $lte: now } },
                    ],
                    updatedAt: { $lte: staleBefore },
                    request: { $exists: true },
                    'redrive.gaveUpAt': { $exists: false },
                } as Filter<RuntimePublication>,
                { projection: { _id: 0 } },
            )
            .sort({ updatedAt: 1 })
            .limit(limit)
            .toArray()) as RuntimePublication[];
    }

    async reserveRedrive(key: string, seenUpdatedAt: string, now: string) {
        const row = await this.collection.findOneAndUpdate(
            {
                key,
                updatedAt: seenUpdatedAt,
                status: { $in: ['failed', 'publishing'] },
                'redrive.gaveUpAt': { $exists: false },
            } as Filter<RuntimePublication>,
            {
                $inc: { 'redrive.attempts': 1 },
                $set: { 'redrive.lastAt': now, updatedAt: now },
            } as any,
            { returnDocument: 'after', projection: { _id: 0 } },
        );
        return (row as RuntimePublication | null) ?? null;
    }

    async giveUp(key: string, reason: string, now: string) {
        await this.collection.updateOne(
            { key },
            {
                $set: {
                    status: 'failed',
                    'redrive.gaveUpAt': now,
                    'redrive.gaveUpReason': reason,
                    updatedAt: now,
                },
                $unset: { leaseUntil: '' },
            } as any,
        );
    }

    async findCheckRunId(key: string) {
        const row = await this.collection.findOne(
            { key, kind: 'check', checkRunId: { $exists: true } },
            { projection: { _id: 0, checkRunId: 1 } },
        );
        return row?.checkRunId ?? null;
    }
}

/**
 * The API's read of `runtime_publications` (the Run page): org-scoped in the
 * query, bounded, and without the stored request. It has no write method.
 */
export class MongoPublicationReader implements PublicationReader {
    constructor(private readonly collection: Collection<RuntimePublication>) {}

    async listForRun(organizationId: string, runId: string) {
        return (await this.collection
            .find(
                { organizationId, runId },
                { projection: { _id: 0, request: 0 } },
            )
            .limit(MAX_ROWS_PER_RUN)
            .toArray()) as RuntimePublication[];
    }
}
