import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `spend_limit_config` to the `organization_parameters_configkey_enum`
 * so the monthly BYOK spend-limit config can be persisted as an
 * organization_parameters row (the feature stores everything in the existing
 * jsonb `configValue`; no new tables/columns).
 *
 * Changing the enum type rewrites the `configKey` column, which means the
 * `IDX_org_params_key_org` index has to be dropped and recreated. That index
 * was originally built CONCURRENTLY (see Indexes1763403030146), so it is
 * rebuilt the same way here — which is why this migration opts out of the
 * per-migration transaction (CREATE/DROP INDEX CONCURRENTLY cannot run inside
 * a transaction block).
 */
export class SpendLimit2026060100000 implements MigrationInterface {
    name = 'SpendLimit2026060100000';

    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_org_params_key_org"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum"
            RENAME TO "organization_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM(
                'category_workitems_type',
                'timezone_config',
                'review_mode_config',
                'kody_fine_tuning_config',
                'auto_join_config',
                'byok_config',
                'cockpit_metrics_visibility',
                'dry_run_limit',
                'auto_license_assignment',
                'code_review_preset',
                'license_key',
                'license_assigned_users',
                'first_review_at',
                'spend_limit_config'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_parameters"
            ALTER COLUMN "configKey" TYPE "public"."organization_parameters_configkey_enum" USING "configKey"::"text"::"public"."organization_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum"
            RENAME TO "workflow_jobs_errorclassification_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum" AS ENUM(
                'RETRYABLE',
                'NON_RETRYABLE',
                'CIRCUIT_OPEN',
                'PERMANENT',
                'RATE_LIMITED'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "errorClassification" TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum" USING "errorClassification"::"text"::"kodus_workflow"."workflow_jobs_errorclassification_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum_old"
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_org_params_key_org" ON "organization_parameters" ("configKey", "organization_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_org_params_key_org"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum_old" AS ENUM(
                'CIRCUIT_OPEN',
                'NON_RETRYABLE',
                'PERMANENT',
                'RETRYABLE'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "errorClassification" TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum_old" USING "errorClassification"::"text"::"kodus_workflow"."workflow_jobs_errorclassification_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_errorclassification_enum_old"
            RENAME TO "workflow_jobs_errorclassification_enum"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_parameters_configkey_enum_old" AS ENUM(
                'auto_join_config',
                'auto_license_assignment',
                'byok_config',
                'category_workitems_type',
                'cockpit_metrics_visibility',
                'code_review_preset',
                'dry_run_limit',
                'first_review_at',
                'kody_fine_tuning_config',
                'license_assigned_users',
                'license_key',
                'review_mode_config',
                'timezone_config'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_parameters"
            ALTER COLUMN "configKey" TYPE "public"."organization_parameters_configkey_enum_old" USING "configKey"::"text"::"public"."organization_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum_old"
            RENAME TO "organization_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_org_params_key_org" ON "organization_parameters" ("configKey", "organization_id")
        `);
    }
}
