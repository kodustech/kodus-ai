import { MigrationInterface, QueryRunner } from "typeorm";

export class AddParametrMaxFiles1743072049009 implements MigrationInterface {
    name = 'AddParametrMaxFiles1743072049009'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."global_parameters_configkey_enum"
            RENAME TO "global_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM(
                'kody_fine_tuning_config',
                'code_review_max_files'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "global_parameters"
            ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum" USING "configKey"::"text"::"public"."global_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."global_parameters_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."global_parameters_configkey_enum_old" AS ENUM('kody_fine_tuning_config')
        `);
        await queryRunner.query(`
            ALTER TABLE "global_parameters"
            ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum_old" USING "configKey"::"text"::"public"."global_parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."global_parameters_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."global_parameters_configkey_enum_old"
            RENAME TO "global_parameters_configkey_enum"
        `);
    }

}
