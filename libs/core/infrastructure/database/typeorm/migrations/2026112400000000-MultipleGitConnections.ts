import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A workspace (team) can hold several Git connections (`integrations` rows).
 *
 * - `integrations.name`: the label owners give a connection.
 * - `integrations.reviewEnabled`: per-connection review switch, on by default
 *   so existing connections keep reviewing.
 * - `user_connection_access`: which non-owner members may read a connection.
 *   Backfilled with every non-owner user of the org for every existing
 *   code-management connection, since today they read the whole org.
 */
export class MultipleGitConnections2026112400000000 implements MigrationInterface {
    name = 'MultipleGitConnections2026112400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD COLUMN IF NOT EXISTS "name" character varying(120)
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ADD COLUMN IF NOT EXISTS "reviewEnabled" boolean NOT NULL DEFAULT true
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "user_connection_access" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "user_id" uuid NOT NULL,
                "integration_id" uuid NOT NULL,
                CONSTRAINT "PK_56ac6378663476232c6e649123c" PRIMARY KEY ("uuid"),
                CONSTRAINT "FK_cc8f529e13be3ad64bffcbc2e2f" FOREIGN KEY ("user_id")
                    REFERENCES "users"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_5dca237c25c49934e3e9115ad0b" FOREIGN KEY ("integration_id")
                    REFERENCES "integrations"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_connection_access_user_integration"
                ON "user_connection_access" ("user_id", "integration_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_user_connection_access_integration"
                ON "user_connection_access" ("integration_id")
        `);

        await queryRunner.query(`
            INSERT INTO "user_connection_access" ("user_id", "integration_id")
            SELECT u."uuid", i."uuid"
              FROM "users" u
              JOIN "integrations" i
                ON i."organization_id" = u."organization_id"
             WHERE u."role" <> 'owner'
               AND i."integrationCategory" = 'CODE_MANAGEMENT'
            ON CONFLICT ("user_id", "integration_id") DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "user_connection_access"`,
        );
        await queryRunner.query(
            `ALTER TABLE "integrations" DROP COLUMN IF EXISTS "reviewEnabled"`,
        );
        await queryRunner.query(
            `ALTER TABLE "integrations" DROP COLUMN IF EXISTS "name"`,
        );
    }
}
