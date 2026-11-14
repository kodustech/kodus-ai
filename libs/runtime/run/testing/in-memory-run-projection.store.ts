import {
    LIVE_RUN_STATES,
    type RunKey,
    type RunListFilter,
    type RunProjectionStore,
    type RunScope,
    type RunReadOptions,
    type RuntimeRunProjection,
} from '../run-projection';

/** In-memory projection for tests and the fake driver: the same filters as the Mongo store. */
export class InMemoryRunProjectionStore implements RunProjectionStore {
    readonly runs = new Map<string, RuntimeRunProjection>();

    async upsert(runId: string, patch: Partial<RuntimeRunProjection>) {
        const prev =
            this.runs.get(runId) ?? ({ runId } as RuntimeRunProjection);
        this.runs.set(runId, {
            ...prev,
            ...patch,
            runId,
            updatedAt: patch.updatedAt ?? new Date().toISOString(),
        });
    }

    async get(runId: string, scope?: RunScope, options?: RunReadOptions) {
        options?.signal?.throwIfAborted();
        const run = this.runs.get(runId) ?? null;
        return run && scope && run.organizationId !== scope.organizationId
            ? null
            : run;
    }

    async findLive(key: RunKey) {
        return [...this.runs.values()].filter(
            (r) =>
                r.organizationId === key.organizationId &&
                r.repositoryId === key.repositoryId &&
                r.prNumber === key.prNumber &&
                LIVE_RUN_STATES.includes(r.state),
        );
    }

    async listLive(organizationId?: string) {
        return [...this.runs.values()].filter(
            (r) =>
                LIVE_RUN_STATES.includes(r.state) &&
                (!organizationId || r.organizationId === organizationId),
        );
    }

    async list(filter: RunListFilter) {
        return [...this.runs.values()]
            .filter(
                (r) =>
                    r.organizationId === filter.organizationId &&
                    (!filter.repositoryId ||
                        r.repositoryId === filter.repositoryId) &&
                    (!filter.repositoryIds ||
                        filter.repositoryIds.includes(r.repositoryId)) &&
                    (filter.prNumber === undefined ||
                        r.prNumber === filter.prNumber) &&
                    (!filter.environmentId ||
                        r.environmentId === filter.environmentId) &&
                    (!filter.requestedSince ||
                        r.requestedAt >= filter.requestedSince),
            )
            .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
            .slice(0, filter.limit ?? 50);
    }
}
