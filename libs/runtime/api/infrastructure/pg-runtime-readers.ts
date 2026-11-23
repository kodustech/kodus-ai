import type { Lesson } from '@libs/runtime/blockers/lessons';
import { PgLessonReads } from '@libs/runtime/blockers/pg-lesson.store';
import { MAX_RUN_LIST_LIMIT, type EnvironmentSetupRecord, type RunKey, type RunListFilter, type RunReadOptions, type RunScope, type RuntimeRunProjection } from '@libs/runtime/run';
import { PgEnvironmentSetupReads, RUNTIME_ENVIRONMENT_SETUPS_TABLE } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { checkReadOptions, PgRunProjectionStore, RUN_COLUMNS, RUNTIME_RUNS_TABLE } from '@libs/runtime/run/adapters/pg-run-projection.store';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type {
    EnvironmentSetupStatus,
    RunSummaryReader,
    RuntimeBuildStateEvictionReader,
    RuntimeEnvironmentReader,
    RuntimeEnvironmentRef,
    RuntimeEnvironmentSetupReader,
    RuntimeLessonReader,
} from '../domain/ports';

/**
 * Read-only view of runtime.runtime_runs. The runtime-worker writes the
 * projection; the API only reads it (ADR-025): this class has no write method
 * at all, and its database is the read-only one (RuntimeReadDb).
 */
export class ReadOnlyRunProjectionStore implements RunSummaryReader {
    private readonly store: PgRunProjectionStore;

    constructor(private readonly db: SqlQuery) {
        this.store = new PgRunProjectionStore(db);
    }

    async get(runId: string, scope?: RunScope, options?: RunReadOptions) {
        if (!options) return this.store.get(runId, scope);
        checkReadOptions(options);
        // The server cancels the query past the timeout (statement_timeout); this bounds the wait for a
        // connection too, and a caller that gave up never starts its query (PgSql checks the signal).
        const controller = new AbortController();
        const abort = () => controller.abort(new Error('Projection read aborted'));
        options.signal?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<RuntimeRunProjection | null>((resolve, reject) => {
                controller.signal.addEventListener('abort', () => reject(new Error('Projection read aborted')), { once: true });
                timer = setTimeout(abort, options.timeoutMs);
                this.store.get(runId, scope, { ...options, signal: controller.signal }).then(resolve, reject);
            });
        } finally {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
    }

    findLive(key: RunKey) {
        return this.store.findLive(key);
    }

    list(filter: RunListFilter) {
        return this.store.list(filter);
    }

    listLive(organizationId?: string) {
        return this.store.listLive(organizationId);
    }

    /** get() with only `reportFields` of the report: what an access check reads (the stream asks it on every long-poll). */
    async getSummary(runId: string, scope: RunScope, reportFields: readonly string[]): Promise<RuntimeRunProjection | null> {
        const columns = RUN_COLUMNS.specs.map(([, c]) => c).join(', ');
        const res = await this.db.query(
            `SELECT ${columns}, (SELECT jsonb_object_agg(k, report->k) FROM unnest($3::text[]) AS k WHERE report ? k) AS report
             FROM ${RUNTIME_RUNS_TABLE} WHERE run_id = $1 AND organization_id = $2`,
            [runId, scope.organizationId, [...reportFields]],
        );
        return res.rows[0] ? RUN_COLUMNS.read(res.rows[0]) : null;
    }

    /**
     * list() with only `reportFields` of each report: Postgres still reads
     * the report, but only those keys reach the API to be parsed (WP10).
     */
    async listSummaries(filter: RunListFilter, reportFields: readonly string[]): Promise<RuntimeRunProjection[]> {
        const where = ['organization_id = $1'];
        const values: unknown[] = [filter.organizationId];
        const param = (value: unknown) => {
            values.push(value);
            return '$' + values.length;
        };
        if (filter.repositoryId) where.push(`repository_id = ${param(filter.repositoryId)}`);
        else if (filter.repositoryIds) where.push(`repository_id = ANY(${param(filter.repositoryIds)}::text[])`);
        if (filter.prNumber !== undefined) where.push(`pr_number = ${param(filter.prNumber)}`);
        if (filter.environmentId) where.push(`environment_id = ${param(filter.environmentId)}`);
        if (filter.requestedSince) where.push(`requested_at >= ${param(filter.requestedSince)}::timestamptz`);
        if (filter.trigger) where.push(`trigger = ${param(filter.trigger)}`);
        const fields = param([...reportFields]);
        const limit = param(Math.min(filter.limit ?? 50, MAX_RUN_LIST_LIMIT));
        const columns = RUN_COLUMNS.specs.map(([, c]) => c).join(', ');
        const res = await this.db.query(
            `SELECT ${columns}, (SELECT jsonb_object_agg(k, report->k) FROM unnest(${fields}::text[]) AS k WHERE report ? k) AS report
             FROM ${RUNTIME_RUNS_TABLE} WHERE ${where.join(' AND ')}
             ORDER BY requested_at DESC NULLS LAST LIMIT ${limit}`,
            values,
        );
        return res.rows.map((r) => RUN_COLUMNS.read(r));
    }
}

/** runtime.runtime_environment_setups, written by the runtime-worker's setup workflow; read by org and environment. */
export class PgEnvironmentSetupReader implements RuntimeEnvironmentSetupReader {
    private readonly reads: PgEnvironmentSetupReads;

    constructor(private readonly db: SqlQuery) {
        this.reads = new PgEnvironmentSetupReads(db);
    }

    get(organizationId: string, environmentId: string): Promise<EnvironmentSetupRecord | null> {
        return this.reads.get(environmentId, organizationId);
    }

    /**
     * The typed columns only, and the progress time of a setup still running:
     * the record (steps, recipe, learn) is not read, so a screen can poll this
     * while a setup runs.
     */
    async statuses(organizationId: string, environmentIds: readonly string[]): Promise<EnvironmentSetupStatus[]> {
        const ids = [...new Set(environmentIds)];
        if (!organizationId || !ids.length) return [];
        const res = await this.db.query(
            `SELECT environment_id, state, requested_at, updated_at,
                    CASE WHEN state = 'setting_up' THEN record->'progress'->>'updatedAt' END AS progress_at
             FROM ${RUNTIME_ENVIRONMENT_SETUPS_TABLE} WHERE organization_id = $1 AND environment_id = ANY($2::text[])`,
            [organizationId, ids],
        );
        return (res.rows as Array<{ environment_id: string; state: string; requested_at: string | Date; updated_at: string | Date; progress_at: string | null }>).map((r) => ({
            environmentId: String(r.environment_id),
            state: r.state as EnvironmentSetupStatus['state'],
            requestedAt: new Date(r.requested_at).toISOString(),
            updatedAt: new Date(r.updated_at).toISOString(),
            ...(r.progress_at ? { progressAt: r.progress_at } : {}),
        }));
    }
}

/** runtime.runtime_build_state_evictions, written by the hub from the cells' heartbeats; read by org and environment. */
export class PgBuildStateEvictionReader implements RuntimeBuildStateEvictionReader {
    constructor(private readonly db: SqlQuery) {}

    async evictions(organizationId: string, environmentId: string): Promise<Array<{ cellId: string; evictedAt: string; freeBytes?: number; floorBytes?: number }>> {
        const res = await this.db.query(
            `SELECT cell_id, evicted_at, free_bytes, floor_bytes FROM runtime.runtime_build_state_evictions WHERE org_id = $1 AND environment_id = $2 ORDER BY evicted_at DESC LIMIT 16`,
            [organizationId, environmentId],
        );
        return (res.rows as Array<{ cell_id: string; evicted_at: string | Date; free_bytes: string | number | null; floor_bytes: string | number | null }>).map((r) => ({
            cellId: r.cell_id,
            evictedAt: new Date(r.evicted_at).toISOString(),
            ...(r.floor_bytes ? { freeBytes: Number(r.free_bytes ?? 0), floorBytes: Number(r.floor_bytes) } : {}),
        }));
    }
}

/** runtime.runtime_lessons: the org's active lessons, the most recent first. */
export class PgLessonReader implements RuntimeLessonReader {
    private readonly reads: PgLessonReads;

    constructor(db: SqlQuery) {
        this.reads = new PgLessonReads(db);
    }

    listByOrganization(organizationId: string): Promise<Lesson[]> {
        return this.reads.listByOrganization(organizationId);
    }
}

/**
 * The environment's image and exposed services: the setup's record first
 * (an environment can be set up before its first Run), the newest Run that
 * used it otherwise (environments that predate the setup records).
 */
export class ProjectionEnvironmentReader implements RuntimeEnvironmentReader {
    private readonly setups: PgEnvironmentSetupReader;

    constructor(private readonly db: SqlQuery) {
        this.setups = new PgEnvironmentSetupReader(db);
    }

    async get(organizationId: string, environmentId: string): Promise<RuntimeEnvironmentRef | null> {
        const setup = await this.setups.get(organizationId, environmentId);
        const res = await this.db.query(
            `SELECT team_id, repository_id, image_id FROM ${RUNTIME_RUNS_TABLE}
             WHERE environment_id = $1 AND organization_id = $2 ORDER BY requested_at DESC NULLS LAST LIMIT 1`,
            [environmentId, organizationId],
        );
        const run = res.rows[0] as { team_id: string | null; repository_id: string | null; image_id: string | null } | undefined;
        const ready = setup && setup.state === 'active' ? setup : null;
        if (!run && !ready) return null;
        const imageId = ready?.imageId ?? run?.image_id ?? undefined;
        const expose = setup?.expose;
        return {
            environmentId,
            organizationId,
            teamId: run?.team_id ?? '',
            repositoryId: run?.repository_id ?? setup?.repositoryId ?? '',
            ...(imageId ? { imageId } : {}),
            ...(expose?.length ? { expose } : {}),
        };
    }
}
