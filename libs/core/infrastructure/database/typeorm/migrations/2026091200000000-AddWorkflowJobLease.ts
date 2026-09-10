import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Licensing job ownership (issue #1830).
 *
 * Before this migration the only thing a crashed/evicted worker left behind
 * was a PROCESSING row and an in-process timeout that died with the process —
 * the stale-job reaper could only wait out `updatedAt` age (180 min) and
 * mislabelled a dead worker as a "legitimately long" run. This adds a lease
 * (`leaseOwner` + `leaseExpiresAt`) the worker renews on a ~30s cadence while
 * processing, so the reaper can reclaim by expiry in ~90s instead of 180 min.
 */
export class AddWorkflowJobLease2026091200000000 implements MigrationInterface {
    name = 'AddWorkflowJobLease2026091200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ADD COLUMN "leaseOwner" varchar(255),
            ADD COLUMN "leaseExpiresAt" timestamp
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            DROP COLUMN "leaseOwner",
            DROP COLUMN "leaseExpiresAt"
        `);
    }
}