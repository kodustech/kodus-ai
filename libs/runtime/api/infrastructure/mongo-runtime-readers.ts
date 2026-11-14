import type { Collection, Db } from 'mongodb';

import {
    type Lesson,
    RUNTIME_LESSONS_COLLECTION,
} from '@libs/runtime/blockers/lessons';
import {
    type EnvironmentSetupRecord,
    MongoRunProjectionStore,
    RUNTIME_ENVIRONMENT_SETUPS_COLLECTION,
    RUNTIME_RUNS_COLLECTION,
    type RunKey,
    type RunListFilter,
    type RunProjectionReader,
    type RunScope,
    type RunReadOptions,
    type RuntimeRunProjection,
} from '@libs/runtime/run';

import type {
    RuntimeEnvironmentReader,
    RuntimeEnvironmentRef,
    RuntimeEnvironmentSetupReader,
    RuntimeLessonReader,
} from '../domain/ports';

/**
 * Read-only view of `runtime_runs`. The runtime-worker writes the projection;
 * the API only reads it (ADR-025): this class has no write method at all.
 */
export class ReadOnlyRunProjectionStore implements RunProjectionReader {
    private store?: MongoRunProjectionStore;

    constructor(private readonly db: () => Promise<Db>) {}

    private async inner() {
        if (!this.store) {
            const collection = (
                await this.db()
            ).collection<RuntimeRunProjection>(RUNTIME_RUNS_COLLECTION);
            this.store = new MongoRunProjectionStore(collection);
        }
        return this.store;
    }

    async get(runId: string, scope?: RunScope, options?: RunReadOptions) {
        if (!options) return (await this.inner()).get(runId, scope);
        if (
            !Number.isInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > 5000
        )
            throw new RangeError('Invalid projection read timeout');
        options.signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () =>
            controller.abort(new Error('Projection read aborted'));
        options.signal?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<RuntimeRunProjection | null>(
                (resolve, reject) => {
                    controller.signal.addEventListener(
                        'abort',
                        () => reject(new Error('Projection read aborted')),
                        { once: true },
                    );
                    timer = setTimeout(abort, options.timeoutMs);
                    this.inner()
                        .then((store) => {
                            // Initialization is shared, but an abandoned caller never starts a late query.
                            controller.signal.throwIfAborted();
                            return store.get(runId, scope, {
                                ...options,
                                signal: controller.signal,
                            });
                        })
                        .then(resolve, reject);
                },
            );
        } finally {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
    }

    async findLive(key: RunKey) {
        return (await this.inner()).findLive(key);
    }

    async list(filter: RunListFilter) {
        return (await this.inner()).list(filter);
    }

    async listLive(organizationId?: string) {
        return (await this.inner()).listLive(organizationId);
    }
}

/** runtime_environment_setups, written by the runtime-worker's setup consumer; read by org and environment. */
export class MongoEnvironmentSetupReader implements RuntimeEnvironmentSetupReader {
    constructor(private readonly db: () => Promise<Db>) {}

    async get(
        organizationId: string,
        environmentId: string,
    ): Promise<EnvironmentSetupRecord | null> {
        const coll: Collection<EnvironmentSetupRecord> = (
            await this.db()
        ).collection(RUNTIME_ENVIRONMENT_SETUPS_COLLECTION);
        return coll.findOne(
            { environmentId, organizationId },
            { projection: { _id: 0 } },
        );
    }
}

export class MongoLessonReader implements RuntimeLessonReader {
    constructor(private readonly db: () => Promise<Db>) {}

    async listByOrganization(organizationId: string): Promise<Lesson[]> {
        const coll: Collection<Lesson> = (await this.db()).collection(
            RUNTIME_LESSONS_COLLECTION,
        );
        return coll
            .find(
                { organizationId, state: 'active' },
                { projection: { _id: 0 } },
            )
            .sort({ lastAt: -1 })
            .limit(500)
            .toArray() as Promise<Lesson[]>;
    }
}

/**
 * The environment's image and exposed services: the setup's record first
 * (an environment can be set up before its first Run), the newest Run that
 * used it otherwise (environments that predate the setup records).
 */
export class ProjectionEnvironmentReader implements RuntimeEnvironmentReader {
    constructor(private readonly db: () => Promise<Db>) {}

    async get(
        organizationId: string,
        environmentId: string,
    ): Promise<RuntimeEnvironmentRef | null> {
        const setup = await new MongoEnvironmentSetupReader(this.db).get(
            organizationId,
            environmentId,
        );
        const runs: Collection<RuntimeRunProjection> = (
            await this.db()
        ).collection(RUNTIME_RUNS_COLLECTION);
        const run = await runs.findOne(
            { environmentId, organizationId },
            {
                sort: { requestedAt: -1 },
                projection: {
                    _id: 0,
                    environmentId: 1,
                    organizationId: 1,
                    teamId: 1,
                    repositoryId: 1,
                    imageId: 1,
                },
            },
        );
        const ready = setup && setup.state === 'active' ? setup : null;
        if (!run && !ready) return null;
        const imageId = ready?.imageId ?? run?.imageId;
        const expose = setup?.expose;
        return {
            environmentId,
            organizationId,
            teamId: run?.teamId ?? '',
            repositoryId: run?.repositoryId ?? setup?.repositoryId ?? '',
            ...(imageId ? { imageId } : {}),
            ...(expose?.length ? { expose } : {}),
        };
    }
}
