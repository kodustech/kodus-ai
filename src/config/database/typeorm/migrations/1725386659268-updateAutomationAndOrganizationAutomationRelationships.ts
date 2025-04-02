import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateAutomationAndOrganizationAutomationRelationships1725386659268 implements MigrationInterface {
    name = 'UpdateAutomationAndOrganizationAutomationRelationships1725386659268'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_automations" DROP CONSTRAINT "FK_4f9be363e42f3bcac60a29b3250"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
                RENAME COLUMN "automation_id" TO "automationUuid"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
            ADD CONSTRAINT "FK_263665174774116226133b7dd23" FOREIGN KEY ("automationUuid") REFERENCES "automation"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organization_automations" DROP CONSTRAINT "FK_263665174774116226133b7dd23"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
                RENAME COLUMN "automationUuid" TO "automation_id"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_automations"
            ADD CONSTRAINT "FK_4f9be363e42f3bcac60a29b3250" FOREIGN KEY ("automation_id") REFERENCES "automation"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

}
