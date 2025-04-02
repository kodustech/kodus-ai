import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAutomationCodeReview1722615951280 implements MigrationInterface {
    name = 'AddAutomationCodeReview1722615951280'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."automation_automationtype_enum"
            RENAME TO "automation_automationtype_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."automation_automationtype_enum" AS ENUM(
                'AutomationTeamProgress',
                'AutomationInteractionMonitor',
                'AutomationIssuesDetails',
                'AutomationImproveTask',
                'AutomationEnsureAssignees',
                'AutomationCommitValidation',
                'AutomationWipLimits',
                'AutomationWaitingConstraints',
                'AutomationTaskBreakdown',
                'AutomationUserRequestedBreakdown',
                'AutomationRetroactiveMovement',
                'AutomationDailyCheckin',
                'AutomationSprintRetro',
                'AutomationExecutiveCheckin',
                'AutomationCodeReview'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ALTER COLUMN "automationType" TYPE "public"."automation_automationtype_enum" USING "automationType"::"text"::"public"."automation_automationtype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."automation_automationtype_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."automation_automationtype_enum_old" AS ENUM(
                'AutomationCommitValidation',
                'AutomationDailyCheckin',
                'AutomationEnsureAssignees',
                'AutomationImproveTask',
                'AutomationInteractionMonitor',
                'AutomationIssuesDetails',
                'AutomationRetroactiveMovement',
                'AutomationSprintRetro',
                'AutomationTaskBreakdown',
                'AutomationTeamProgress',
                'AutomationUserRequestedBreakdown',
                'AutomationWaitingConstraints',
                'AutomationWipLimits'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "automation"
            ALTER COLUMN "automationType" TYPE "public"."automation_automationtype_enum_old" USING "automationType"::"text"::"public"."automation_automationtype_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."automation_automationtype_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."automation_automationtype_enum_old"
            RENAME TO "automation_automationtype_enum"
        `);
    }

}
