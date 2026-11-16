import type { Sql } from '@libs/runtime/api/infrastructure/typeorm-sql';
import { DocumentTable, jsonb } from '@libs/runtime/run/adapters/pg-document';

import {
    COMMENT_SLOT_LEASE_MS,
    definedOnly,
    type CommentSlotPatch,
    type PullRequestCommentSlot,
    type PullRequestCommentSlotStore,
    type PullRequestRef,
} from '../domain/pull-request-comment-slot';

export const RUNTIME_PR_COMMENTS_TABLE = 'runtime_pr_comments';

export const SLOT_COLUMNS = new DocumentTable<PullRequestCommentSlot>(
    [
        ['organizationId', 'organization_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['prNumber', 'pr_number', 'integer'],
        ['environmentKey', 'environment_key', 'text'],
        ['teamId', 'team_id', 'text'],
        ['commentOrder', 'comment_order', 'integer'],
        ['leaseOwner', 'lease_owner', 'text'],
        ['leaseUntil', 'lease_until', 'timestamptz'],
        ['updatedAt', 'updated_at', 'timestamptz'],
    ],
    // Not a jsonb rest: `comment` and `create_pending` are read below.
    'rest',
);

const COLUMNS = `${SLOT_COLUMNS.specs.map(([, c]) => c).join(', ')}, comment, create_pending`;

const fromRow = (row: Record<string, unknown>): PullRequestCommentSlot => {
    // The repository's own environment ('') reads as the slot always did: no key.
    const { environmentKey, ...slot } = SLOT_COLUMNS.read({ ...row, rest: null });
    return {
        ...slot,
        ...(environmentKey ? { environmentKey } : {}),
        ...(row.comment ? { comment: row.comment as PullRequestCommentSlot['comment'] } : {}),
        ...(row.create_pending ? { createPending: true } : {}),
    };
};

const pk = (pr: PullRequestRef) => [pr.organizationId, pr.repositoryId, pr.prNumber, pr.environmentKey ?? ''];

/** `runtime_pr_comments` in the product Postgres: one row per (org, repo, PR, environment key), its primary key. */
export class TypeOrmCommentSlotStore implements PullRequestCommentSlotStore {
    constructor(private readonly sql: Sql) {}

    /** The first use inserts the slot; a slot whose lease lapsed is taken by one conditional update; a live lease answers null (busy). */
    async acquire(pr: PullRequestRef, owner: string, now = new Date()): Promise<PullRequestCommentSlot | null> {
        const nowIso = now.toISOString();
        const row = (
            await this.sql.query(
                `INSERT INTO ${RUNTIME_PR_COMMENTS_TABLE} AS s (organization_id, repository_id, pr_number, environment_key, team_id, lease_owner, lease_until, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (organization_id, repository_id, pr_number, environment_key) DO UPDATE
                 SET team_id = EXCLUDED.team_id, lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at
                 WHERE s.lease_until IS NULL OR s.lease_until <= $8::timestamptz
                 RETURNING ${COLUMNS}`,
                [...pk(pr), pr.teamId, owner, new Date(now.getTime() + COMMENT_SLOT_LEASE_MS).toISOString(), nowIso],
            )
        ).rows[0];
        return row ? fromRow(row) : null;
    }

    /** Writes the patch only while `owner` still holds the lease; createPending false clears it. */
    async update(pr: PullRequestRef, owner: string, patch: CommentSlotPatch) {
        const { createPending, comment, commentOrder } = patch;
        const set: string[] = [];
        const values: unknown[] = [...pk(pr), owner];
        const add = (sql: (n: string) => string, v: unknown) => {
            values.push(v);
            set.push(sql(`$${values.length}`));
        };
        const defined = definedOnly({ comment, commentOrder });
        if ('comment' in defined) add((n) => `comment = ${n}::jsonb`, jsonb(defined.comment));
        if ('commentOrder' in defined) add((n) => `comment_order = ${n}`, defined.commentOrder);
        if (createPending) set.push('create_pending = true');
        if (createPending === false) set.push('create_pending = NULL');
        add((n) => `updated_at = ${n}`, new Date().toISOString());
        await this.sql.query(
            `UPDATE ${RUNTIME_PR_COMMENTS_TABLE} SET ${set.join(', ')} WHERE organization_id = $1 AND repository_id = $2 AND pr_number = $3 AND environment_key = $4 AND lease_owner = $5`,
            values,
        );
    }

    /** Drops the lease of `owner`; a lease taken over by someone else is left alone. */
    async release(pr: PullRequestRef, owner: string) {
        await this.sql.query(
            `UPDATE ${RUNTIME_PR_COMMENTS_TABLE} SET lease_owner = NULL, lease_until = NULL
             WHERE organization_id = $1 AND repository_id = $2 AND pr_number = $3 AND environment_key = $4 AND lease_owner = $5`,
            [...pk(pr), owner],
        );
    }
}
