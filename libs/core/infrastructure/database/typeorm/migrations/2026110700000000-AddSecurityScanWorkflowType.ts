import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The security scan (#2451) runs as a workflow job of its own type.
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, hence
 * `transaction = false`; `IF NOT EXISTS` makes a re-run harmless.
 */
export class AddSecurityScanWorkflowType2026110700000000
    implements MigrationInterface
{
    name = 'AddSecurityScanWorkflowType2026110700000000';

    transaction = false as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
            ADD VALUE IF NOT EXISTS 'SECURITY_SCAN'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Postgres cannot drop an enum value; jobs of this type are removed so
        // the value is unused.
        await queryRunner.query(`
            DELETE FROM "kodus_workflow"."workflow_jobs"
            WHERE "workflowType" = 'SECURITY_SCAN'
        `);
    }
}
