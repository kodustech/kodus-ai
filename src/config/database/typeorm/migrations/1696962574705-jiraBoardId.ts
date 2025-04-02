import { MigrationInterface, QueryRunner } from 'typeorm';

export class JiraBoardId1696962574705 implements MigrationInterface {
    name = 'JiraBoardId1696962574705';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "jira"
            ADD "boardId" character varying
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "jira" DROP COLUMN "boardId"
        `);
    }
}
