import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTableGlobalParameters1744241683720 implements MigrationInterface {
    name = 'AddTableGlobalParameters1744241683720'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM(
                'kody_fine_tuning_config',
                'code_review_max_files'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "global_parameters" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "configKey" "public"."global_parameters_configkey_enum" NOT NULL,
                "configValue" jsonb NOT NULL,
                "description" character varying,
                CONSTRAINT "PK_9af9c70370b4c6800e268f936b2" PRIMARY KEY ("uuid")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "global_parameters"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."global_parameters_configkey_enum"
        `);
    }

}
