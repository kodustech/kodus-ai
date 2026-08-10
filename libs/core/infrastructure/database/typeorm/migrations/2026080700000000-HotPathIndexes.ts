import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hot-path indexes born from the 2026-08-06 pool-exhaustion audit.
 *
 * Foreign keys in Postgres create constraints, not indexes — every
 * lookup that filtered by these columns was doing a Seq Scan. That
 * showed up in prod as pool starvation because the scans held a
 * connection just long enough to overlap the next hit.
 *
 *   1. team_member(user_id) — every request that resolves "who owns
 *      this team member" (auth, permissions, membership) filtered by
 *      the implicit FK, which had no supporting index.
 *
 *   2. team_member(organization_id, team_id) — team scoping joins on
 *      the code-review and cockpit paths.
 *
 *   3. team_member(communicationId) partial — Slack/Teams user
 *      lookup. Most rows have NULL communicationId; the partial
 *      keeps the index tiny while covering the hot query.
 *
 *   4. auth(userUuid) — the `DELETE FROM auth WHERE "userUuid" = $1`
 *      leg of UserRepository.delete used to Seq Scan; also hit when
 *      refresh tokens are issued for a user with existing sessions.
 *
 * The UNIQUE index on profile_configs(profile_id, configKey) ships
 * separately (needs a preflight de-dup step) — see the sibling
 * `ProfileConfigsUniqueKey` migration.
 */
export class HotPathIndexes2026080700000000 implements MigrationInterface {
    name = 'HotPathIndexes2026080700000000';

    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        try {
            await this.runUp(queryRunner);
        } finally {
            await this.resetTimeouts(queryRunner);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        try {
            await this.runDown(queryRunner);
        } finally {
            await this.resetTimeouts(queryRunner);
        }
    }

    /**
     * `SET` without `LOCAL` is session-scoped, and `transaction = false`
     * rules out `SET LOCAL`. TypeORM runs this migration on a pooled
     * connection, so without an explicit RESET the connection goes back to
     * the pool carrying `statement_timeout = 0` — which would silently
     * disable the 30s statement cap this same change adds to the pool
     * config, on exactly one connection, for the life of the process.
     */
    private async resetTimeouts(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`RESET statement_timeout`);
        await queryRunner.query(`RESET lock_timeout`);
    }

    private async runUp(queryRunner: QueryRunner): Promise<void> {
        // CONCURRENTLY on tables that have grown large can run for many
        // minutes. A global statement_timeout would abort mid-build and
        // leave an INVALID index that IF NOT EXISTS then silently skips
        // forever. Disable it just for this migration session; keep
        // lock_timeout bounded because CONCURRENTLY still takes brief
        // ACCESS SHARE locks.
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        // ─────────────────────────────────────────────────────────────
        // 1. team_member(user_id)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_team_member_user');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_user"
                ON "team_member" ("user_id")
        `);

        // ─────────────────────────────────────────────────────────────
        // 2. team_member(organization_id, team_id)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_team_member_org_team');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_org_team"
                ON "team_member" ("organization_id", "team_id")
        `);

        // ─────────────────────────────────────────────────────────────
        // 3. team_member(communicationId) — partial (skip null rows)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_team_member_comm_id');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_comm_id"
                ON "team_member" ("communicationId")
                WHERE "communicationId" IS NOT NULL
        `);

        // ─────────────────────────────────────────────────────────────
        // 4. auth(userUuid)
        // ─────────────────────────────────────────────────────────────
        await this.dropIfInvalid(queryRunner, 'IDX_auth_user');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_auth_user"
                ON "auth" ("userUuid")
        `);
    }

    private async runDown(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        // DROP INDEX CONCURRENTLY also cannot run inside a transaction.
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "IDX_auth_user"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "IDX_team_member_comm_id"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "IDX_team_member_org_team"`,
        );
        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "IDX_team_member_user"`,
        );
    }

    /**
     * Drops an index only if Postgres flagged it invalid (a killed
     * CONCURRENTLY build). Must run as a top-level statement — DROP
     * INDEX CONCURRENTLY cannot execute inside a transaction/DO block.
     */
    private async dropIfInvalid(
        queryRunner: QueryRunner,
        indexName: string,
    ): Promise<void> {
        const invalid = (await queryRunner.query(
            `SELECT 1
               FROM pg_class c
               JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = $1
                AND NOT i.indisvalid`,
            [indexName],
        )) as unknown[];
        if (invalid.length) {
            await queryRunner.query(
                `DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`,
            );
        }
    }
}
