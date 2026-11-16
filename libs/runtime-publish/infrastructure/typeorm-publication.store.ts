import type { Sql } from '@libs/runtime/api/infrastructure/typeorm-sql';
import { DocumentTable, jsonb } from '@libs/runtime/run/adapters/pg-document';

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

export const RUNTIME_PUBLICATIONS_TABLE = 'runtime_publications';

/** A Run publishes a check, a comment per phase and a reply per confirmed suggestion: far below this. */
const MAX_ROWS_PER_RUN = 50;

/** What the claims and the sweeper filter on; checkRunId, comment, reason, fallback, redrive… are `detail`. The request has its own column. */
export const PUBLICATION_COLUMNS = new DocumentTable<RuntimePublication>(
    [
        ['key', 'key', 'text'],
        ['runId', 'run_id', 'text'],
        ['attempt', 'attempt', 'integer'],
        ['kind', 'kind', 'text'],
        ['organizationId', 'organization_id', 'text'],
        ['teamId', 'team_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['prNumber', 'pr_number', 'integer'],
        ['headSha', 'head_sha', 'text'],
        ['status', 'status', 'text'],
        ['leaseUntil', 'lease_until', 'timestamptz'],
        ['checkRank', 'check_rank', 'integer'],
        ['createdAt', 'created_at', 'timestamptz'],
        ['updatedAt', 'updated_at', 'timestamptz'],
    ],
    'detail',
);

const SELECT_WITH_REQUEST = `${PUBLICATION_COLUMNS.selectList}, request`;

const fromRow = (row: Record<string, unknown>, withRequest = true): RuntimePublication => {
    const p = PUBLICATION_COLUMNS.read(row);
    return withRequest && row.request ? { ...p, request: row.request as RuntimePublication['request'] } : p;
};

/** An UPDATE's SET list from a patch: typed columns set, the rest merged into `detail`. */
function setList(patch: Record<string, unknown>, first: number): { sql: string[]; values: unknown[] } {
    const split = PUBLICATION_COLUMNS.split(patch);
    const sql = split.columns.map((c, i) => `${c} = $${first + i}`);
    const values: unknown[] = [...split.values];
    if (Object.keys(split.rest).length) {
        values.push(jsonb(split.rest));
        sql.push(`detail = detail || $${first + values.length - 1}::jsonb`);
    }
    return { sql, values };
}

/** `runtime_publications` in the product Postgres: one row per `runId:attempt:kind`, the key its primary key. */
export class TypeOrmPublicationStore implements PublicationStore, PublicationRedriveStore {
    constructor(private readonly sql: Sql) {}

    async claim(request: ClaimRequest, now = new Date()): Promise<ClaimResult> {
        const nowIso = now.toISOString();
        const leaseUntil = new Date(now.getTime() + PUBLICATION_LEASE_MS).toISOString();
        const isCheck = request.kind === 'check';

        // Same rule as canClaim(), as one atomic conditional update.
        const taken = await this.sql.query(
            `UPDATE ${RUNTIME_PUBLICATIONS_TABLE}
             SET status = 'publishing', lease_until = $2, updated_at = $3, request = COALESCE($4::jsonb, request)
             WHERE key = $1
               AND (status = 'failed' OR (status = 'publishing' AND lease_until <= $3) OR ($5::boolean AND status = 'published'))
               AND (NOT $5::boolean OR check_rank IS NULL OR check_rank < $6::int)
             RETURNING ${SELECT_WITH_REQUEST}`,
            [request.key, leaseUntil, nowIso, request.request ? jsonb(request.request) : null, isCheck, request.checkRank ?? 0],
        );
        if (taken.rows[0]) return { state: 'claimed', publication: fromRow(taken.rows[0]) };

        const { checkRank: _rank, request: stored, ...fields } = request;
        const fresh: RuntimePublication = {
            ...fields,
            ...(stored ? { request: stored } : {}),
            status: 'publishing',
            leaseUntil,
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const { request: _r, ...row } = fresh;
        const split = PUBLICATION_COLUMNS.split(row as Record<string, unknown>);
        const columns = [...split.columns, 'detail', 'request'];
        const inserted = await this.sql.query(
            `INSERT INTO ${RUNTIME_PUBLICATIONS_TABLE} (${columns.join(', ')})
             VALUES (${columns.map((c, i) => (c === 'detail' || c === 'request' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
             ON CONFLICT (key) DO NOTHING RETURNING key`,
            [...split.values, jsonb(split.rest), stored ? jsonb(stored) : null],
        );
        if (inserted.rows.length) return { state: 'claimed', publication: fresh };

        const existing = (await this.sql.query(`SELECT ${SELECT_WITH_REQUEST} FROM ${RUNTIME_PUBLICATIONS_TABLE} WHERE key = $1`, [request.key])).rows[0];
        // Deleted between the insert and the read: let the broker retry.
        if (!existing) return { state: 'busy', publication: fresh };
        const publication = fromRow(existing);
        return { state: refusalState(publication, now), publication };
    }

    async complete(key: string, result: PublicationResult) {
        const set = setList({ ...definedOnly(result), updatedAt: new Date().toISOString() }, 2);
        await this.sql.query(`UPDATE ${RUNTIME_PUBLICATIONS_TABLE} SET ${[...set.sql, 'lease_until = NULL'].join(', ')} WHERE key = $1`, [key, ...set.values]);
    }

    async release(key: string, reason: string, keep?: PublicationRetryState) {
        const set = setList({ ...definedOnly(keep ?? {}), status: 'failed', reason, updatedAt: new Date().toISOString() }, 2);
        await this.sql.query(`UPDATE ${RUNTIME_PUBLICATIONS_TABLE} SET ${[...set.sql, 'lease_until = NULL'].join(', ')} WHERE key = $1`, [key, ...set.values]);
    }

    /** Same rule as isStaleForRedrive(). */
    async findStale(staleBefore: string, now: string, limit: number) {
        const rows = (
            await this.sql.query(
                `SELECT ${SELECT_WITH_REQUEST} FROM ${RUNTIME_PUBLICATIONS_TABLE}
                 WHERE request IS NOT NULL AND status IN ('failed', 'publishing')
                   AND (status = 'failed' OR lease_until <= $2::timestamptz)
                   AND updated_at <= $1::timestamptz
                   AND NOT (COALESCE(detail->'redrive', '{}'::jsonb) ? 'gaveUpAt')
                 ORDER BY updated_at LIMIT $3`,
                [staleBefore, now, limit],
            )
        ).rows;
        return rows.map((r) => fromRow(r));
    }

    async reserveRedrive(key: string, seenUpdatedAt: string, now: string) {
        const row = (
            await this.sql.query(
                `UPDATE ${RUNTIME_PUBLICATIONS_TABLE}
                 SET detail = jsonb_set(detail, '{redrive}', COALESCE(detail->'redrive', '{}'::jsonb)
                         || jsonb_build_object('attempts', COALESCE((detail->'redrive'->>'attempts')::int, 0) + 1, 'lastAt', $3::text)),
                     updated_at = $3::timestamptz
                 WHERE key = $1 AND updated_at = $2::timestamptz AND status IN ('failed', 'publishing')
                   AND NOT (COALESCE(detail->'redrive', '{}'::jsonb) ? 'gaveUpAt')
                 RETURNING ${SELECT_WITH_REQUEST}`,
                [key, seenUpdatedAt, now],
            )
        ).rows[0];
        return row ? fromRow(row) : null;
    }

    async giveUp(key: string, reason: string, now: string) {
        await this.sql.query(
            `UPDATE ${RUNTIME_PUBLICATIONS_TABLE}
             SET status = 'failed', lease_until = NULL, updated_at = $3::timestamptz,
                 detail = jsonb_set(detail, '{redrive}', COALESCE(detail->'redrive', '{}'::jsonb) || jsonb_build_object('gaveUpAt', $3::text, 'gaveUpReason', $2::text))
             WHERE key = $1`,
            [key, reason, now],
        );
    }

    async findCheckRunId(key: string) {
        const row = (await this.sql.query(`SELECT detail->'checkRunId' AS id FROM ${RUNTIME_PUBLICATIONS_TABLE} WHERE key = $1 AND kind = 'check' AND detail ? 'checkRunId'`, [key])).rows[0];
        return (row?.id as string | number | null | undefined) ?? null;
    }
}

/**
 * The API's read of `runtime_publications` (the Run page): org-scoped in the
 * query, bounded, and without the stored request. It has no write method.
 */
export class TypeOrmPublicationReader implements PublicationReader {
    constructor(private readonly sql: Sql) {}

    async listForRun(organizationId: string, runId: string) {
        const rows = (
            await this.sql.query(
                `SELECT ${PUBLICATION_COLUMNS.selectList} FROM ${RUNTIME_PUBLICATIONS_TABLE} WHERE organization_id = $1 AND run_id = $2 ORDER BY created_at, key LIMIT ${MAX_ROWS_PER_RUN}`,
                [organizationId, runId],
            )
        ).rows;
        return rows.map((r) => fromRow(r, false));
    }
}
