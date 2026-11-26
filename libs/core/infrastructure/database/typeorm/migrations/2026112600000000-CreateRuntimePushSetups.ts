import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime default-branch push setups (docs/runtime/fork-from-checkpoint.md R6): per environment, the newest
 * commit pushed that no setup has taken yet (pushes are coalesced) and how many setups the pushes started on a UTC
 * day (the daily budget). Product Postgres, written only by the product worker.
 */
export class CreateRuntimePushSetups2026112600000000 implements MigrationInterface {
    name = 'CreateRuntimePushSetups2026112600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_push_setups" (
                "organization_id" character varying(128) NOT NULL,
                "environment_id" character varying(128) NOT NULL,
                "pending_sha" character varying(64),
                "pending_at" TIMESTAMP WITH TIME ZONE,
                "day" date,
                "day_count" integer NOT NULL DEFAULT 0,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_runtime_push_setups" PRIMARY KEY ("organization_id", "environment_id"),
                CONSTRAINT "CHK_runtime_push_setups_day_count" CHECK ("day_count" >= 0)
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_runtime_push_setups_pending" ON "runtime_push_setups" ("pending_at") WHERE "pending_sha" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_push_setups"`);
    }
}
