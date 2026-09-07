import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds a nullable producer key so webhook redeliveries create one workflow. */
export class WorkflowJobIdempotency2026090300000000 implements MigrationInterface {
    name = 'WorkflowJobIdempotency2026090300000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ADD COLUMN IF NOT EXISTS "idempotencyKey" character varying(255)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_workflow_jobs_idempotency_key"
            ON "kodus_workflow"."workflow_jobs" ("idempotencyKey")
            WHERE "idempotencyKey" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "kodus_workflow"."UQ_workflow_jobs_idempotency_key"
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            DROP COLUMN IF EXISTS "idempotencyKey"
        `);
    }
}
