import {
    LIVE_RUN_STATES,
    MAX_RUN_LIST_LIMIT,
    type RunKey,
    type RunListFilter,
    type RunProjectionStore,
    type RunReadOptions,
    type RunScope,
    type RuntimeRunProjection,
} from '../run-projection';
import { DocumentTable, jsonb } from './pg-document';
import type { SqlQuery } from './pg-sql';

// The Run projection in the Runtime Postgres (runtime.runtime_runs, docs §8).
// The runtime-worker writes it from the DBOS step of each transition; the API
// and the product worker read it with the read-only role
// (RUNTIME_DATABASE_READ_URL). The DBOS workflow stays the source of truth.

export const RUNTIME_RUNS_TABLE = 'runtime.runtime_runs';

/** The live-Run index (runtime-schema.ts v21): one live Run per org, repository, PR, head and environment. */
export const ONE_LIVE_RUN_PER_ENVIRONMENT_SHA = 'runtime_runs_one_live_per_environment_sha';

/** What the reads filter and sort on, as columns; everything else of the projection is `report`. */
export const RUN_COLUMNS = new DocumentTable<RuntimeRunProjection>(
    [
        ['runId', 'run_id', 'text'],
        ['organizationId', 'organization_id', 'text'],
        ['teamId', 'team_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['repositoryName', 'repository_name', 'text'],
        ['prNumber', 'pr_number', 'integer'],
        ['headSha', 'head_sha', 'text'],
        ['baseSha', 'base_sha', 'text'],
        ['baseBranch', 'base_branch', 'text'],
        ['environmentId', 'environment_id', 'text'],
        ['imageId', 'image_id', 'text'],
        ['attempt', 'attempt', 'integer'],
        ['correlationId', 'correlation_id', 'text'],
        ['state', 'state', 'text'],
        ['verdictState', 'verdict_state', 'text'],
        ['phase', 'phase', 'text'],
        ['trigger', 'trigger', 'text'],
        ['requestedAt', 'requested_at', 'timestamptz'],
        ['startedAt', 'started_at', 'timestamptz'],
        ['finishedAt', 'finished_at', 'timestamptz'],
        ['updatedAt', 'updated_at', 'timestamptz'],
    ],
    'report',
);

const LIVE = [...LIVE_RUN_STATES];

/** The fields an external verification reads: the proof's metadata, never the logs or the steps. */
function externalProofView(run: RuntimeRunProjection): RuntimeRunProjection {
    const pick = <K extends keyof RuntimeRunProjection>(...keys: K[]) =>
        Object.fromEntries(keys.filter((k) => run[k] !== undefined).map((k) => [k, run[k]])) as Pick<RuntimeRunProjection, K>;
    return {
        ...pick('runId', 'organizationId', 'teamId', 'repositoryId', 'prNumber', 'headSha', 'imageId', 'state', 'finishedAt'),
        ...(Array.isArray(run.probes)
            ? {
                  probes: run.probes.map((p) => {
                      const q = p as unknown as Record<string, unknown>;
                      return Object.fromEntries(['probeId', 'verdict', 'baseStepIds', 'prStepIds'].filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
                  }) as unknown as RuntimeRunProjection['probes'],
              }
            : {}),
    } as RuntimeRunProjection;
}

/** Bounded reads must name a timeout between 1 and 5000 ms, and only the views there are. */
export function checkReadOptions(options?: RunReadOptions) {
    options?.signal?.throwIfAborted();
    if (options && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5000)) throw new RangeError('Invalid projection read timeout');
    if (options?.view && options.view !== 'external_verification') throw new RangeError('Invalid projection view');
}

export class PgRunProjectionStore implements RunProjectionStore {
    constructor(private readonly db: SqlQuery) {}

    /** Sets the fields of the patch, the others are kept; a field patched to undefined reads as null (as Mongo's $set). */
    async upsert(runId: string, patch: Partial<RuntimeRunProjection>) {
        const { runId: _ignored, ...rest } = patch;
        const split = RUN_COLUMNS.split({ ...rest, updatedAt: patch.updatedAt ?? new Date().toISOString() });
        const columns = ['run_id', ...split.columns, 'report'];
        const values = [runId, ...split.values, jsonb(split.rest)];
        const placeholders = columns.map((c, i) => (c === 'report' ? `$${i + 1}::jsonb` : `$${i + 1}`));
        const updates = [...split.columns.map((c) => `${c} = EXCLUDED.${c}`), 'report = runtime_runs.report || EXCLUDED.report'];
        await this.db.query(
            `INSERT INTO ${RUNTIME_RUNS_TABLE} AS runtime_runs (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
             ON CONFLICT (run_id) DO UPDATE SET ${updates.join(', ')}`,
            values,
        );
    }

    async get(runId: string, scope?: RunScope, options?: RunReadOptions) {
        checkReadOptions(options);
        const res = await this.db.query(
            `SELECT ${RUN_COLUMNS.selectList} FROM ${RUNTIME_RUNS_TABLE} WHERE run_id = $1${scope ? ' AND organization_id = $2' : ''}`,
            scope ? [runId, scope.organizationId] : [runId],
            options ? { timeoutMs: options.timeoutMs, signal: options.signal } : undefined,
        );
        const run = res.rows[0] ? RUN_COLUMNS.read(res.rows[0]) : null;
        return run && options?.view === 'external_verification' ? externalProofView(run) : run;
    }

    async findLive(key: RunKey) {
        const res = await this.db.query(
            `SELECT ${RUN_COLUMNS.selectList} FROM ${RUNTIME_RUNS_TABLE}
             WHERE organization_id = $1 AND repository_id = $2 AND pr_number = $3 AND state = ANY($4::text[])`,
            [key.organizationId, key.repositoryId, key.prNumber, LIVE],
        );
        return res.rows.map((r) => RUN_COLUMNS.read(r));
    }

    async listLive(organizationId?: string) {
        const res = await this.db.query(
            `SELECT ${RUN_COLUMNS.selectList} FROM ${RUNTIME_RUNS_TABLE}
             WHERE state = ANY($1::text[])${organizationId ? ' AND organization_id = $2' : ''} LIMIT 1000`,
            organizationId ? [LIVE, organizationId] : [LIVE],
        );
        return res.rows.map((r) => RUN_COLUMNS.read(r));
    }

    async list(filter: RunListFilter) {
        const where = ['organization_id = $1'];
        const values: unknown[] = [filter.organizationId];
        const add = (sql: (n: string) => string, value: unknown) => {
            values.push(value);
            where.push(sql(`$${values.length}`));
        };
        if (filter.repositoryId) add((n) => `repository_id = ${n}`, filter.repositoryId);
        else if (filter.repositoryIds) add((n) => `repository_id = ANY(${n}::text[])`, filter.repositoryIds);
        if (filter.prNumber !== undefined) add((n) => `pr_number = ${n}`, filter.prNumber);
        if (filter.environmentId) add((n) => `environment_id = ${n}`, filter.environmentId);
        if (filter.requestedSince) add((n) => `requested_at >= ${n}::timestamptz`, filter.requestedSince);
        if (filter.trigger) add((n) => `trigger = ${n}`, filter.trigger);
        values.push(Math.min(filter.limit ?? 50, MAX_RUN_LIST_LIMIT));
        const res = await this.db.query(
            `SELECT ${RUN_COLUMNS.selectList} FROM ${RUNTIME_RUNS_TABLE} WHERE ${where.join(' AND ')}
             ORDER BY requested_at DESC NULLS LAST LIMIT $${values.length}`,
            values,
        );
        return res.rows.map((r) => RUN_COLUMNS.read(r));
    }
}
