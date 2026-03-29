import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClassificationToSessionEvents1772576294050 implements MigrationInterface {
    name = 'AddClassificationToSessionEvents1772576294050';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "session_events"
            ADD "classification_status" character varying(20)
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events"
            ADD "decisions" jsonb
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events"
            ADD "classification_source" character varying(30)
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events"
            ADD "classification_error" text
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events"
            ADD "classified_at" TIMESTAMP
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "session_events" DROP COLUMN "classified_at"
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events" DROP COLUMN "classification_error"
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events" DROP COLUMN "classification_source"
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events" DROP COLUMN "decisions"
        `);
        await queryRunner.query(`
            ALTER TABLE "session_events" DROP COLUMN "classification_status"
        `);
    }
}
