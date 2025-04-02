import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewIntegrationConfigKeyProjectManagementSetupConfig1713292647308
    implements MigrationInterface
{
    name =
        'AddNewIntegrationConfigKeyProjectManagementSetupConfig1713292647308';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role"
            SET NOT NULL
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            RENAME TO "integration_configs_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."integration_configs_configkey_enum" AS ENUM(
                'columns_mapping',
                'project_management_setup_config',
                'repositories',
                'installation_github',
                'channel_info',
                'msteams_installation_app',
                'waiting_columns',
                'doing_column',
                'daily_checkin_schedule',
                'module_workitems_types',
                'bug_type_identifier',
                'automation_issue_alert_time',
                'team_project_management_methodology'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ALTER COLUMN "configKey" TYPE "public"."integration_configs_configkey_enum" USING "configKey"::"text"::"public"."integration_configs_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integration_configs_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."integration_configs_configkey_enum_old" AS ENUM(
                'automation_issue_alert_time',
                'bug_type_identifier',
                'channel_info',
                'columns_mapping',
                'daily_checkin_schedule',
                'doing_column',
                'installation_github',
                'module_workitems_types',
                'msteams_installation_app',
                'repositories',
                'team_project_management_methodology',
                'waiting_columns'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ALTER COLUMN "configKey" TYPE "public"."integration_configs_configkey_enum_old" USING "configKey"::"text"::"public"."integration_configs_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."integration_configs_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum_old"
            RENAME TO "integration_configs_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" DROP NOT NULL
        `);
    }
}
