import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewColumnAutomationExecute1710168959140
    implements MigrationInterface
{
    name = 'AddNewColumnAutomationExecute1710168959140';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "automation_execution"
            ADD "origin" character varying
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "automation_execution" DROP COLUMN "origin"
        `);
    }
}
