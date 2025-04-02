import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlatformConfigParameter1731094293658 implements MigrationInterface {
    name = 'AddPlatformConfigParameter1731094293658'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_platform_enum"
            RENAME TO "integrations_platform_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integrations_platform_enum" AS ENUM(
                'GITHUB',
                'GITLAB',
                'JIRA',
                'SLACK',
                'NOTION',
                'MSTEAMS',
                'DISCORD',
                'AZURE_BOARDS',
                'AZURE_REPOS',
                'KODUS_WEB'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "platform" TYPE "public"."integrations_platform_enum" USING "platform"::"text"::"public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum_old"
        `);
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
                'platform_configs'
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
            CREATE TYPE "public"."integrations_platform_enum_old" AS ENUM(
                'AZURE_BOARDS',
                'AZURE_REPOS',
                'DISCORD',
                'GITHUB',
                'GITLAB',
                'JIRA',
                'MSTEAMS',
                'NOTION',
                'SLACK'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integrations"
            ALTER COLUMN "platform" TYPE "public"."integrations_platform_enum_old" USING "platform"::"text"::"public"."integrations_platform_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integrations_platform_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_platform_enum_old"
            RENAME TO "integrations_platform_enum"
        `);
    }

}
