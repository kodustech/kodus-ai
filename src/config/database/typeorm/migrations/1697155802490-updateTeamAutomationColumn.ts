import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateTeamAutomationColumn1697155802490
    implements MigrationInterface
{
    name = 'UpdateTeamAutomationColumn1697155802490';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_automations"
                RENAME COLUMN "isActive" TO "status"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_automations"
                RENAME COLUMN "status" TO "isActive"
        `);
    }
}
