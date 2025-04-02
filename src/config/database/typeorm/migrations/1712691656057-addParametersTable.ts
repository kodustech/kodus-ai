import { MigrationInterface, QueryRunner } from "typeorm";

export class AddParametersTable1712691656057 implements MigrationInterface {
    name = 'AddParametersTable1712691656057'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum" AS ENUM('team_artifacts_config')
        `);
        await queryRunner.query(`
            CREATE TABLE "parameters" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "configKey" "public"."parameters_configkey_enum" NOT NULL,
                "configValue" jsonb NOT NULL,
                "description" character varying,
                "team_id" uuid,
                CONSTRAINT "PK_e9d8d2297cdf6f98eb2e5941e0b" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "parameters"
            ADD CONSTRAINT "FK_acbd8447ca6aab80fd58870a52c" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "parameters" DROP CONSTRAINT "FK_acbd8447ca6aab80fd58870a52c"
        `);
        await queryRunner.query(`
            DROP TABLE "parameters"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum"
        `);
    }

}
