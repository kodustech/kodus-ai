import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTableOrganizationAutomationExecution1722619938066 implements MigrationInterface {
    name = 'CreateTableOrganizationAutomationExecution1722619938066'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."organization_automation_execution_status_enum" AS ENUM('success', 'error')
        `);
        await queryRunner.query(`
            CREATE TABLE "organization_automation_execution" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "status" "public"."organization_automation_execution_status_enum" NOT NULL DEFAULT 'success',
                "errorMessage" character varying,
                "dataExecution" jsonb,
                "origin" character varying,
                "organization_automation_id" uuid,
                CONSTRAINT "PK_eb98550ecde5d5edc9bb6370f27" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automation_execution"
            ADD CONSTRAINT "FK_a92fbb5c128c3f85f1f17d8d3c1" FOREIGN KEY ("organization_automation_id") REFERENCES "organization_automations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_automation_execution" DROP CONSTRAINT "FK_a92fbb5c128c3f85f1f17d8d3c1"
        `);
        await queryRunner.query(`
            DROP TABLE "organization_automation_execution"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_automation_execution_status_enum"
        `);
    }

}
