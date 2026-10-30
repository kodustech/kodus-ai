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
 *
 * No session-level timeout juggling here: `migration:run` is its own
 * CLI process against ormconfig.ts, whose pool sets no
 * statement_timeout, and it exits when the run finishes. The only
 * addition over the plain CONCURRENTLY form is `dropIfInvalid` — see
 * its doc for the failure it covers.
 */
export class HotPathIndexes2026080700000000 implements MigrationInterface {
    name = 'HotPathIndexes2026080700000000';

    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.dropIfInvalid(queryRunner, 'IDX_team_member_user');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_user"
                ON "team_member" ("user_id")
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_team_member_org_team');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_org_team"
                ON "team_member" ("organization_id", "team_id")
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_team_member_comm_id');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_team_member_comm_id"
                ON "team_member" ("communicationId")
                WHERE "communicationId" IS NOT NULL
        `);

        await this.dropIfInvalid(queryRunner, 'IDX_auth_user');
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_auth_user"
                ON "auth" ("userUuid")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
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
     * Drops an index only if Postgres flagged it invalid.
     *
     * A CONCURRENTLY build that dies halfway (deploy timeout, killed pod,
     * dropped connection) leaves the index in place but INVALID. Plain
     * `IF NOT EXISTS` sees the name, decides there is nothing to do, and
     * the index stays broken forever — the table reads as indexed while
     * every query still Seq Scans it. Clearing the invalid leftover first
     * makes a re-run actually rebuild.
     *
     * Must run as a top-level statement: DROP INDEX CONCURRENTLY cannot
     * execute inside a transaction or a DO block.
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
