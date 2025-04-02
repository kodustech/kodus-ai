import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateAutomationTables1697399139716 implements MigrationInterface {
    name = 'UpdateAutomationTables1697399139716';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "automation"
                RENAME COLUMN "version" TO "automationType"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations" DROP COLUMN "version"
        `);
        await queryRunner.query(`
            ALTER TABLE "automation" DROP COLUMN "automationType"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."automation_automationtype_enum" AS ENUM(
                'AutomationTeamProgress',
                'AutomationInteractionMonitor',
                'AutomationIssuesDetails',
                'AutomationImproveTask'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ADD "automationType" "public"."automation_automationtype_enum" NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ADD CONSTRAINT "UQ_0320df2b2a4c8112d8dcd77ea3f" UNIQUE ("automationType")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "automation" DROP CONSTRAINT "UQ_0320df2b2a4c8112d8dcd77ea3f"
        `);
        await queryRunner.query(`
            ALTER TABLE "automation" DROP COLUMN "automationType"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."automation_automationtype_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ADD "automationType" character varying NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations"
            ADD "version" character varying NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
                RENAME COLUMN "automationType" TO "version"
        `);
    }
}
