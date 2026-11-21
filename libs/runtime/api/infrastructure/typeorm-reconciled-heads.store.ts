import { RECONCILE_MAX_ATTEMPTS, RECONCILE_STALE_CLAIM_MS, type ReconciledHeadKey, type ReconciledHeadStore } from '../domain/webhook-reconciler';
import type { Sql } from './typeorm-sql';

export const RUNTIME_RECONCILED_HEADS_TABLE = 'runtime_reconciled_heads';
/** How long a handed head is remembered; past it, the head is outside any reconcile window (at most 7 days). */
export const RECONCILED_HEADS_RETENTION_DAYS = 30;

const KEY = 'organization_id = $1 AND repository_id = $2 AND pr_number = $3 AND head_sha = $4';
const keyValues = (k: ReconciledHeadKey) => [k.organizationId, k.repositoryId, k.prNumber, k.headSha];

/**
 * The reconciler's ledger in the product Postgres. One statement claims a
 * head: the insert wins for a new head; on a conflict the row is taken over
 * only when its last attempt failed or went stale, under the attempt limit.
 * Postgres locks the conflicting row, so of two replicas claiming one head at
 * once the second sees the first's claim and gets nothing. `attempts` fences
 * the settle: a holder whose claim was taken over writes nothing.
 */
export class TypeOrmReconciledHeadStore implements ReconciledHeadStore {
    constructor(
        private readonly sql: Sql,
        private readonly limits = { maxAttempts: RECONCILE_MAX_ATTEMPTS, staleClaimMs: RECONCILE_STALE_CLAIM_MS },
    ) {}

    async claim(key: ReconciledHeadKey): Promise<number | null> {
        const { rows } = await this.sql.query(
            `INSERT INTO ${RUNTIME_RECONCILED_HEADS_TABLE} AS h (organization_id, repository_id, pr_number, head_sha, state, attempts, claimed_at, updated_at)
             VALUES ($1, $2, $3, $4, 'claimed', 1, now(), now())
             ON CONFLICT (organization_id, repository_id, pr_number, head_sha) DO UPDATE
                SET state = 'claimed', attempts = h.attempts + 1, outcome = NULL, claimed_at = now(), updated_at = now()
              WHERE h.attempts < $5
                AND (h.state = 'failed' OR (h.state = 'claimed' AND h.claimed_at < now() - ($6::double precision * interval '1 millisecond')))
             RETURNING attempts`,
            [...keyValues(key), this.limits.maxAttempts, this.limits.staleClaimMs],
        );
        return rows.length ? Number(rows[0].attempts) : null;
    }

    async settle(key: ReconciledHeadKey, attempt: number, outcome: string): Promise<void> {
        await this.sql.query(
            `UPDATE ${RUNTIME_RECONCILED_HEADS_TABLE} SET state = 'decided', outcome = $6, updated_at = now() WHERE ${KEY} AND state = 'claimed' AND attempts = $5`,
            [...keyValues(key), attempt, outcome.slice(0, 64)],
        );
    }

    async fail(key: ReconciledHeadKey, attempt: number, reason: string): Promise<void> {
        await this.sql.query(
            `UPDATE ${RUNTIME_RECONCILED_HEADS_TABLE} SET state = 'failed', outcome = $6, updated_at = now() WHERE ${KEY} AND state = 'claimed' AND attempts = $5`,
            [...keyValues(key), attempt, reason.slice(0, 64)],
        );
    }
}
