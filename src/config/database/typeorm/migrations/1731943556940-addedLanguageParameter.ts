import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedLanguageParameter1731943556940 implements MigrationInterface {
    name = 'AddedLanguageParameter1731943556940'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum"
            RENAME TO "parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum" AS ENUM(
                'board_priority_type',
                'checkin_config',
                'code_review_config',
                'communication_style',
                'deployment_type',
                'organization_artifacts_config',
                'team_artifacts_config',
                'platform_configs',
                'language_config'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "parameters"
            ALTER COLUMN "configKey" TYPE "public"."parameters_configkey_enum" USING "configKey"::"text"::"public"."parameters_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum_old" AS ENUM(
                'board_priority_type',
                'checkin_config',
                'code_review_config',
                'communication_style',
                'deployment_type',
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
    }

}
