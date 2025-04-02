import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateParametersType1716930181508 implements MigrationInterface {
    name = 'UpdateParametersType1716930181508'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum"
            RENAME TO "parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum" AS ENUM(
                'team_artifacts_config',
                'organization_artifacts_config',
                'deployment_type',
                'board_priority_type'
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
    }

}
