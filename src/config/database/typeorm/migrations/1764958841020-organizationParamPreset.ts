import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationParamPreset1764958841020 implements MigrationInterface {
    name = 'OrganizationParamPreset1764958841020'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."IDX_org_params_key_org"
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
                'code_review_preset'
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
            CREATE INDEX IF NOT EXISTS "IDX_org_params_key_org" ON "organization_parameters" ("configKey", "organization_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."IDX_org_params_key_org"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."organization_parameters_configkey_enum_old" AS ENUM(
                'auto_join_config',
                'auto_license_assignment',
                'byok_config',
                'category_workitems_type',
                'cockpit_metrics_visibility',
                'dry_run_limit',
                'kody_fine_tuning_config',
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
            CREATE INDEX "IDX_org_params_key_org" ON "organization_parameters" ("configKey", "organization_id")
        `);
    }

}
