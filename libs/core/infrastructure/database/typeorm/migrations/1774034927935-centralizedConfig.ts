import { MigrationInterface, QueryRunner } from 'typeorm';

export class CentralizedConfig1774034927935 implements MigrationInterface {
    name = 'CentralizedConfig1774034927935';

    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.startTransaction();

        try {
            await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."IDX_parameters_key_team_active"
        `);
            await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum"
            RENAME TO "parameters_configkey_enum_old"
        `);
            await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum" AS ENUM(
                'code_review_config',
                'platform_configs',
                'language_config',
                'issue_creation_config',
                'centralized_config',
                'team_artifacts_config',
                'organization_artifacts_config',
                'communication_style',
                'checkin_config',
                'board_priority_type',
                'deployment_type'
            )
        `);
            await queryRunner.query(`
            ALTER TABLE "parameters"
            ALTER COLUMN "configKey" TYPE "public"."parameters_configkey_enum" USING "configKey"::"text"::"public"."parameters_configkey_enum"
        `);
            await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum_old"
        `);

            await queryRunner.commitTransaction();
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        }

        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_parameters_key_team_active" ON "parameters" ("configKey", "team_id", "active")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_parameters_key_team_active"
        `);

        await queryRunner.startTransaction();

        try {
            await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum_old" AS ENUM(
                'board_priority_type',
                'checkin_config',
                'code_review_config',
                'communication_style',
                'deployment_type',
                'issue_creation_config',
                'language_config',
                'organization_artifacts_config',
                'platform_configs',
                'team_artifacts_config'
            )
        `);
            await queryRunner.query(`
            ALTER TABLE "parameters"
            ALTER COLUMN "configKey" TYPE "public"."parameters_configkey_enum_old" USING "configKey"::"text"::"public"."parameters_configkey_enum_old"
        `);
            await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum"
        `);
            await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum_old"
            RENAME TO "parameters_configkey_enum"
        `);
            await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_parameters_key_team_active" ON "parameters" ("configKey", "active", "team_id")
        `);

            await queryRunner.commitTransaction();
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        }
    }
}
