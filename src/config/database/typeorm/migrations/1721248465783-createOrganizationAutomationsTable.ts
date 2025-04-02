import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOrganizationAutomationsTable1721248465783 implements MigrationInterface {
    name = 'CreateOrganizationAutomationsTable1721248465783'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "organization_automations" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "status" boolean NOT NULL DEFAULT true,
                "organization_id" uuid,
                "automation_id" uuid,
                CONSTRAINT "PK_e8b71d3e3c7fcac35735c8e8adf" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
            ADD CONSTRAINT "FK_7da0ec969570f23655947e77829" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
            ADD CONSTRAINT "FK_4f9be363e42f3bcac60a29b3250" FOREIGN KEY ("automation_id") REFERENCES "automation"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_automations" DROP CONSTRAINT "FK_4f9be363e42f3bcac60a29b3250"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations" DROP CONSTRAINT "FK_7da0ec969570f23655947e77829"
        `);
        await queryRunner.query(`
            DROP TABLE "organization_automations"
        `);
    }

}
