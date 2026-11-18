import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime, product screens 2 and 8: when the Runtime runs on a repo
 * (mode off | on_request | rules, the rules, and two switches), and the
 * 👍/👎 per tested path of a Run, one per user. Product Postgres, written
 * only by the API.
 */
export class AddRuntimeRepositoryModeAndFindingFeedback2026103100000000 implements MigrationInterface {
    name = 'AddRuntimeRepositoryModeAndFindingFeedback2026103100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" ADD COLUMN IF NOT EXISTS "mode" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" ADD COLUMN IF NOT EXISTS "rules" jsonb NOT NULL DEFAULT '[]'::jsonb`);
        await queryRunner.query(
            `ALTER TABLE "runtime_repository_settings" ADD COLUMN IF NOT EXISTS "run_on_agent_prs" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "runtime_repository_settings" ADD COLUMN IF NOT EXISTS "run_on_new_pushes" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_finding_feedback" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "run_id" character varying(128) NOT NULL,
                "probe_id" character varying(128) NOT NULL,
                "user_id" character varying(128) NOT NULL,
                "value" character varying(8) NOT NULL,
                CONSTRAINT "PK_runtime_finding_feedback" PRIMARY KEY ("uuid"),
                CONSTRAINT "CHK_runtime_finding_feedback_value" CHECK ("value" IN ('up', 'down'))
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_finding_feedback_run_probe_user" ON "runtime_finding_feedback" ("run_id", "probe_id", "user_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_finding_feedback_org_run" ON "runtime_finding_feedback" ("organization_id", "run_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_finding_feedback"`);
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" DROP COLUMN IF EXISTS "run_on_new_pushes"`);
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" DROP COLUMN IF EXISTS "run_on_agent_prs"`);
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" DROP COLUMN IF EXISTS "rules"`);
        await queryRunner.query(`ALTER TABLE "runtime_repository_settings" DROP COLUMN IF EXISTS "mode"`);
    }
}
