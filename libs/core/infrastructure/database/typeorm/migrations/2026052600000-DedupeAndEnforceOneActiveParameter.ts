import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two-step migration that closes the duplicate-active-parameter race:
 *
 *   1) Heal any team that already has > 1 active row for the same configKey
 *      by keeping only the newest version active (the older orphans were
 *      left behind by the unfixed read/update/insert flow in
 *      ParametersService.createOrUpdateConfig). This step has to run before
 *      step 2, otherwise the unique index creation would fail against any
 *      team already in the bad state.
 *
 *   2) Add a partial unique index that makes the invariant unbreakable at
 *      the DB level: at most one active row per (team_id, configKey). Even
 *      if two concurrent writers race past the application-level guard,
 *      Postgres will reject the second INSERT.
 */
export class DedupeAndEnforceOneActiveParameter2026052600000
    implements MigrationInterface
{
    name = 'DedupeAndEnforceOneActiveParameter2026052600000';

    // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "parameters" AS p
               SET active = false,
                   "updatedAt" = NOW()
              FROM (
                    SELECT uuid
                      FROM (
                            SELECT uuid,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY team_id, "configKey"
                                       ORDER BY version DESC, "createdAt" DESC
                                   ) AS rn
                              FROM "parameters"
                             WHERE active = true
                           ) ranked
                     WHERE ranked.rn > 1
                   ) stale
             WHERE p.uuid = stale.uuid
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
                "UQ_parameters_one_active_per_team_key"
              ON "parameters" ("team_id", "configKey")
              WHERE "active" = true
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS
                "public"."UQ_parameters_one_active_per_team_key"
        `);
        // The deduplication in up() is intentionally not reversed — the
        // post-migration state is the canonical one and the orphan rows
        // are recoverable from version history if anyone ever needs them.
    }
}
