import type { Sql } from '@libs/runtime/api/infrastructure/typeorm-sql';

import { CHECK_SLOT_LEASE_MS, type PullRequestCheckRef, type PullRequestCheckSlot, type PullRequestCheckSlotStore } from '../domain/pull-request-check-slot';

export const RUNTIME_PR_CHECKS_TABLE = 'runtime_pr_checks';
/**
 * How long a head's slot is kept untouched (the Runtime product retention
 * cron). An older Run's last redrive comes within about an hour
 * (publication-redrive.ts); a Run on that head later takes a new slot.
 */
export const PR_CHECKS_RETENTION_DAYS = 30;

const COLUMNS = 'organization_id, repository_id, head_sha, check_name, check_order, lease_owner, lease_until, updated_at';
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : undefined);

const fromRow = (row: Record<string, unknown>): PullRequestCheckSlot => ({
    organizationId: String(row.organization_id),
    repositoryId: String(row.repository_id),
    headSha: String(row.head_sha),
    checkName: String(row.check_name),
    ...(row.check_order !== null && row.check_order !== undefined ? { checkOrder: Number(row.check_order) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(iso(row.lease_until) ? { leaseUntil: iso(row.lease_until)! } : {}),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
});

const pk = (ref: PullRequestCheckRef) => [ref.organizationId, ref.repositoryId, ref.headSha, ref.checkName];

/** `runtime_pr_checks` in the product Postgres: one row per (org, repo, head, check name), its primary key. */
export class TypeOrmCheckSlotStore implements PullRequestCheckSlotStore {
    constructor(private readonly sql: Sql) {}

    /** The first use inserts the slot; a slot whose lease lapsed is taken by one conditional update; a live lease answers null (busy). */
    async acquire(ref: PullRequestCheckRef, owner: string, now = new Date()): Promise<PullRequestCheckSlot | null> {
        const nowIso = now.toISOString();
        const row = (
            await this.sql.query(
                `INSERT INTO ${RUNTIME_PR_CHECKS_TABLE} AS s (organization_id, repository_id, head_sha, check_name, lease_owner, lease_until, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (organization_id, repository_id, head_sha, check_name) DO UPDATE
                 SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at
                 WHERE s.lease_until IS NULL OR s.lease_until <= $7::timestamptz
                 RETURNING ${COLUMNS}`,
                [...pk(ref), owner, new Date(now.getTime() + CHECK_SLOT_LEASE_MS).toISOString(), nowIso],
            )
        ).rows[0];
        return row ? fromRow(row) : null;
    }

    async recordOrder(ref: PullRequestCheckRef, owner: string, order: number) {
        await this.sql.query(
            `UPDATE ${RUNTIME_PR_CHECKS_TABLE} SET check_order = GREATEST(COALESCE(check_order, $6), $6), updated_at = $7
             WHERE organization_id = $1 AND repository_id = $2 AND head_sha = $3 AND check_name = $4 AND lease_owner = $5`,
            [...pk(ref), owner, order, new Date().toISOString()],
        );
    }

    async release(ref: PullRequestCheckRef, owner: string) {
        await this.sql.query(
            `UPDATE ${RUNTIME_PR_CHECKS_TABLE} SET lease_owner = NULL, lease_until = NULL
             WHERE organization_id = $1 AND repository_id = $2 AND head_sha = $3 AND check_name = $4 AND lease_owner = $5`,
            [...pk(ref), owner],
        );
    }
}
