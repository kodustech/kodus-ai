import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime, the Run page: a developer's "this change is intended" on a
 * finding of a Run, one per finding (who marked it, and when). A learning
 * signal kept in the product; it never changes the Run's verdict or check.
 * Product Postgres, written only by the API.
 */
export class AddRuntimeFindingIntent2026110700000001 implements MigrationInterface {
    name = 'AddRuntimeFindingIntent2026110700000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_finding_intent" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "run_id" character varying(128) NOT NULL,
                "probe_id" character varying(128) NOT NULL,
                "user_id" character varying(128) NOT NULL,
                CONSTRAINT "PK_runtime_finding_intent" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_finding_intent_run_probe" ON "runtime_finding_intent" ("run_id", "probe_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_finding_intent_org_run" ON "runtime_finding_intent" ("organization_id", "run_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_finding_intent"`);
    }
}
