import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCliCodeReviewWorkflowType2026042900100
    implements MigrationInterface
{
    name = 'AddCliCodeReviewWorkflowType2026042900100';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
            RENAME TO "workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum" AS ENUM(
                'CODE_REVIEW',
                'CLI_CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING',
                'CHECK_SUGGESTION_IMPLEMENTATION',
                'AST_GRAPH_BUILD',
                'AST_GRAPH_INCREMENTAL'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
            USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DELETE FROM "kodus_workflow"."workflow_jobs"
            WHERE "workflowType" = 'CLI_CODE_REVIEW'
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old" AS ENUM(
                'CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING',
                'CHECK_SUGGESTION_IMPLEMENTATION',
                'AST_GRAPH_BUILD',
                'AST_GRAPH_INCREMENTAL'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
            USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
            RENAME TO "workflow_jobs_workflowtype_enum"
        `);
    }
}
