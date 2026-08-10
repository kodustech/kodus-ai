import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UNIQUE(profile_id, configKey) on profile_configs.
 *
 * Doubles as (a) the lookup index for the hot
 * `findOne({ profile: { uuid }, configKey })` path AND (b) the
 * DB-level guard against the race that
 * ProfileConfigService.createOrUpdateConfig used to hit — the prior
 * `forEach(async ...)` (see commit that fixed it) dropped the
 * returned promises, so two concurrent callers could both see null
 * on findOne and both take the create branch, producing duplicate
 * rows. Even after the code fix the UNIQUE is worth having to keep
 * any future caller (or a redelivered outbox event) from ever
 * writing a duplicate.
 *
 * Shipped separately from the other hot-path indexes because a
 * preflight de-dup step is required: the UNIQUE build would fail on
 * any existing duplicate rows produced by the historical race.
 */
export class ProfileConfigsUniqueKey2026080700000001 implements MigrationInterface {
    name = 'ProfileConfigsUniqueKey2026080700000001';

    // CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a transaction.
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
     * Session-scoped SETs must not ride the pooled connection back into the
     * application. See the sibling HotPathIndexes migration for the full
     * rationale.
     */
    private async resetTimeouts(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`RESET statement_timeout`);
        await queryRunner.query(`RESET lock_timeout`);
    }

    private async runUp(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        // Preflight: collapse historical duplicates before the UNIQUE
        // build. Keep the newest row per (profile_id, configKey) — the
        // last write in the racing pair is the one the caller
        // intended. Uses ROW_NUMBER over the deterministic
        // (createdAt DESC, uuid DESC) ordering; running twice is a
        // no-op because the DELETE only touches rows ranked > 1.
        await queryRunner.query(`
            WITH ranked AS (
                SELECT uuid,
                       ROW_NUMBER() OVER (
                           PARTITION BY profile_id, "configKey"
                           ORDER BY "createdAt" DESC, uuid DESC
                       ) AS rn
                  FROM profile_configs
            )
            DELETE FROM profile_configs
             WHERE uuid IN (SELECT uuid FROM ranked WHERE rn > 1)
        `);

        // Self-heal a prior interrupted CONCURRENTLY build.
        await this.dropIfInvalid(queryRunner, 'UQ_profile_configs_profile_key');

        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_profile_configs_profile_key"
                ON "profile_configs" ("profile_id", "configKey")
        `);
    }

    private async runDown(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SET statement_timeout = 0`);
        await queryRunner.query(`SET lock_timeout = '30s'`);

        await queryRunner.query(
            `DROP INDEX CONCURRENTLY IF EXISTS "UQ_profile_configs_profile_key"`,
        );
        // No undo for the de-dup DELETE — duplicates were already
        // wrong and there is no safe way to recreate them.
    }

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
