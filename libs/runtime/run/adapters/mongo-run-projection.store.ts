import type { Collection } from 'mongodb';

import {
    LIVE_RUN_STATES,
    MAX_RUN_LIST_LIMIT,
    type RunKey,
    type RunListFilter,
    type RunProjectionStore,
    type RunScope,
    type RunReadOptions,
    type RuntimeRunProjection,
} from '../run-projection';

const LIVE = [...LIVE_RUN_STATES];
const EXTERNAL_PROOF_PROJECTION = {
    '_id': 0,
    'runId': 1,
    'organizationId': 1,
    'teamId': 1,
    'repositoryId': 1,
    'prNumber': 1,
    'headSha': 1,
    'imageId': 1,
    'state': 1,
    'finishedAt': 1,
    'probes.probeId': 1,
    'probes.verdict': 1,
    'probes.baseStepIds': 1,
    'probes.prStepIds': 1,
} as const;

/** `runtime_runs` in Mongo; the runtime-worker writes it, the API reads it through a read-only wrapper. */
export class MongoRunProjectionStore implements RunProjectionStore {
    constructor(
        private readonly collection: Collection<RuntimeRunProjection>,
    ) {}

    static async ensureIndexes(collection: Collection<RuntimeRunProjection>) {
        await collection.createIndex({ runId: 1 }, { unique: true });
        await collection.createIndex(
            { organizationId: 1, repositoryId: 1, prNumber: 1, headSha: 1 },
            {
                unique: true,
                partialFilterExpression: { state: { $in: LIVE } },
                name: 'one_live_run_per_sha',
            },
        );
        await collection.createIndex({ state: 1, updatedAt: 1 });
        await collection.createIndex({
            organizationId: 1,
            repositoryId: 1,
            requestedAt: -1,
        });
        // The org-wide list (runs page, environments) and the environment reads.
        await collection.createIndex({ organizationId: 1, requestedAt: -1 });
        await collection.createIndex({ environmentId: 1, requestedAt: -1 });
    }

    async upsert(runId: string, patch: Partial<RuntimeRunProjection>) {
        const { runId: _ignored, ...rest } = patch;
        await this.collection.updateOne(
            { runId },
            {
                $set: {
                    ...rest,
                    updatedAt: patch.updatedAt ?? new Date().toISOString(),
                },
                $setOnInsert: { runId },
            },
            { upsert: true },
        );
    }

    async get(runId: string, scope?: RunScope, options?: RunReadOptions) {
        options?.signal?.throwIfAborted();
        if (
            options &&
            (!Number.isInteger(options.timeoutMs) ||
                options.timeoutMs < 1 ||
                options.timeoutMs > 5000)
        )
            throw new RangeError('Invalid projection read timeout');
        if (options?.view && options.view !== 'external_verification')
            throw new RangeError('Invalid projection view');
        return this.collection.findOne(
            scope ? { runId, organizationId: scope.organizationId } : { runId },
            {
                projection:
                    options?.view === 'external_verification'
                        ? EXTERNAL_PROOF_PROJECTION
                        : { _id: 0 },
                ...(options
                    ? {
                          timeoutMS: options.timeoutMs,
                          maxTimeMS: options.timeoutMs,
                          signal: options.signal,
                      }
                    : {}),
            },
        );
    }

    async findLive(key: RunKey) {
        return this.collection
            .find({ ...key, state: { $in: LIVE } }, { projection: { _id: 0 } })
            .toArray();
    }

    async listLive(organizationId?: string) {
        const q: Record<string, unknown> = { state: { $in: LIVE } };
        if (organizationId) q.organizationId = organizationId;
        return this.collection
            .find(q, { projection: { _id: 0 } })
            .limit(1_000)
            .toArray();
    }

    async list(filter: RunListFilter) {
        const q: Record<string, unknown> = {
            organizationId: filter.organizationId,
        };
        if (filter.repositoryId) q.repositoryId = filter.repositoryId;
        else if (filter.repositoryIds)
            q.repositoryId = { $in: filter.repositoryIds };
        if (filter.prNumber !== undefined) q.prNumber = filter.prNumber;
        if (filter.environmentId) q.environmentId = filter.environmentId;
        if (filter.requestedSince)
            q.requestedAt = { $gte: filter.requestedSince };
        return this.collection
            .find(q, { projection: { _id: 0 } })
            .sort({ requestedAt: -1 })
            .limit(Math.min(filter.limit ?? 50, MAX_RUN_LIST_LIMIT))
            .toArray();
    }
}
