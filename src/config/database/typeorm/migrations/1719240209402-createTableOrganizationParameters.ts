import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTableOrganizationParameters1719240209402 implements MigrationInterface {
    name = 'CreateTableOrganizationParameters1719240209402'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM('category_workitems_type')
        `);
        await queryRunner.query(`
            CREATE TABLE "organization_parameters" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "configKey" "public"."organization_parameters_configkey_enum" NOT NULL,
                "configValue" jsonb NOT NULL,
                "description" character varying,
                "organization_id" uuid,
                CONSTRAINT "PK_3bd84bdeae04e1cb5b4654c3c0b" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_parameters"
            ADD CONSTRAINT "FK_9b62581310b3d2336de90debafc" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_parameters" DROP CONSTRAINT "FK_9b62581310b3d2336de90debafc"
        `);
        await queryRunner.query(`
            DROP TABLE "organization_parameters"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_parameters_configkey_enum"
        `);
    }

}
