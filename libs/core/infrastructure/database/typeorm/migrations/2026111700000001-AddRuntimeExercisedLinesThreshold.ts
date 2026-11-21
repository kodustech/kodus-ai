import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime exercised lines (docs/runtime/exercised-lines.md §7): the
 * org's own threshold, 0 to 100 (0 never holds a Run back). Null, the
 * default, keeps the deployment's RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT.
 * The API validates the range; a value outside it reads as null.
 */
export class AddRuntimeExercisedLinesThreshold2026111700000001 implements MigrationInterface {
    name = 'AddRuntimeExercisedLinesThreshold2026111700000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" ADD COLUMN IF NOT EXISTS "exercised_lines_threshold_percent" smallint`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" DROP COLUMN IF EXISTS "exercised_lines_threshold_percent"`);
    }
}
