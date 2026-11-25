import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `suggestions_mv.suggestionImplementationCheckOutcome`: whether the last
 * implementation check decided the suggestion's status or could not
 * (`unmeasured`). The Cockpit counts the undecided apart instead of reading
 * them as not implemented. Null for suggestions no check has looked at since.
 */
export class AddSuggestionImplementationCheckOutcome2026110700000000 implements MigrationInterface {
    name = 'AddSuggestionImplementationCheckOutcome2026110700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "analytics"."suggestions_mv"
                ADD COLUMN IF NOT EXISTS "suggestionImplementationCheckOutcome" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "analytics"."suggestions_mv"
                DROP COLUMN IF EXISTS "suggestionImplementationCheckOutcome"
        `);
    }
}
