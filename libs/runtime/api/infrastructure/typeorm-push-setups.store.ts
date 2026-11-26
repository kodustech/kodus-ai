import type { PushSetupClaim, PushSetupKey, PushSetupLedger } from '../domain/push-setup';
import type { Sql } from './typeorm-sql';

export const RUNTIME_PUSH_SETUPS_TABLE = 'runtime_push_setups';

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The push setup ledger in the product Postgres, one row per environment. Every step is one statement, so two
 * replicas handling pushes of one environment never both take the pending commit or both pass the daily limit: the
 * claim locks the row (FOR UPDATE), a second claim waits and then finds nothing pending.
 */
export class TypeOrmPushSetupLedger implements PushSetupLedger {
    constructor(private readonly sql: Sql) {}

    async markPending(key: PushSetupKey, sha: string, at: Date): Promise<void> {
        await this.sql.query(
            `INSERT INTO ${RUNTIME_PUSH_SETUPS_TABLE} (organization_id, environment_id, pending_sha, pending_at, updated_at)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (organization_id, environment_id) DO UPDATE SET pending_sha = $3, pending_at = $4, updated_at = $4`,
            [key.organizationId, key.environmentId, sha, at],
        );
    }

    async claim(key: PushSetupKey, at: Date, dailyLimit: number): Promise<PushSetupClaim> {
        const { rows } = await this.sql.query(
            `WITH cur AS (
                SELECT pending_sha, CASE WHEN day = $3::date THEN day_count ELSE 0 END AS spent
                  FROM ${RUNTIME_PUSH_SETUPS_TABLE}
                 WHERE organization_id = $1 AND environment_id = $2 AND pending_sha IS NOT NULL
                   FOR UPDATE
             )
             UPDATE ${RUNTIME_PUSH_SETUPS_TABLE} t
                SET pending_sha = NULL, pending_at = NULL, day = $3::date, updated_at = $5,
                    day_count = cur.spent + CASE WHEN cur.spent < $4 THEN 1 ELSE 0 END
               FROM cur
              WHERE t.organization_id = $1 AND t.environment_id = $2
          RETURNING cur.pending_sha AS sha, cur.spent AS spent, (cur.spent < $4) AS claimed`,
            [key.organizationId, key.environmentId, dayOf(at), dailyLimit, at],
        );
        if (!rows.length) return { status: 'none' };
        const spent = Number(rows[0].spent);
        return rows[0].claimed
            ? { status: 'claimed', sha: String(rows[0].sha), spentToday: spent + 1 }
            : { status: 'budget_spent', sha: String(rows[0].sha), spentToday: spent };
    }

    async restorePending(key: PushSetupKey, sha: string, at: Date): Promise<void> {
        await this.sql.query(
            `UPDATE ${RUNTIME_PUSH_SETUPS_TABLE}
                SET pending_sha = COALESCE(pending_sha, $3), pending_at = COALESCE(pending_at, $4), updated_at = $4,
                    day_count = CASE WHEN day = $5::date AND day_count > 0 THEN day_count - 1 ELSE day_count END
              WHERE organization_id = $1 AND environment_id = $2`,
            [key.organizationId, key.environmentId, sha, at, dayOf(at)],
        );
    }

    async clearPending(key: PushSetupKey, sha: string): Promise<void> {
        await this.sql.query(
            `UPDATE ${RUNTIME_PUSH_SETUPS_TABLE} SET pending_sha = NULL, pending_at = NULL
              WHERE organization_id = $1 AND environment_id = $2 AND pending_sha = $3`,
            [key.organizationId, key.environmentId, sha],
        );
    }

    async listPending(limit: number) {
        const { rows } = await this.sql.query(
            `SELECT organization_id, environment_id, pending_sha FROM ${RUNTIME_PUSH_SETUPS_TABLE}
              WHERE pending_sha IS NOT NULL ORDER BY pending_at LIMIT $1`,
            [limit],
        );
        return rows.map((r) => ({ organizationId: String(r.organization_id), environmentId: String(r.environment_id), sha: String(r.pending_sha) }));
    }
}
