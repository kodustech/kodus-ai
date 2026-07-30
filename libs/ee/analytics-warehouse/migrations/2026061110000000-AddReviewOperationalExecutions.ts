import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Materialized terminal review executions for cockpit operational metrics.
 * This keeps cockpit reads on the analytics schema while the analytics worker
 * owns OLTP extraction and incremental sync.
 */
export class AddReviewOperationalExecutions2026061110000000
    implements MigrationInterface
{
    name = 'AddReviewOperationalExecutions2026061110000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."review_operational_executions" (
                "automation_execution_id" uuid PRIMARY KEY,
                "organizationId" text NOT NULL,
                "team_id" uuid,
                "team_automation_id" uuid,
                "repositoryId" text,
                "repo_full_name" text,
                "pullRequestNumber" integer,
                "status" text NOT NULL,
                "created_at" timestamptz NOT NULL,
                "source_updated_at" timestamptz NOT NULL,
                "ingested_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_review_ops_org_created"
                ON "analytics"."review_operational_executions" ("organizationId", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_review_ops_org_repo_created"
                ON "analytics"."review_operational_executions" ("organizationId", "repo_full_name", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_review_ops_org_status_created"
                ON "analytics"."review_operational_executions" ("organizationId", "status", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_review_ops_source_watermark"
                ON "analytics"."review_operational_executions" ("source_updated_at", "automation_execution_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "analytics"."review_operational_executions"`,
        );
    }
}
