import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the check of a partly tested Kody Runtime Run with something left to
 * decide concludes (owner decision of 2026-11-18): null, the default, is
 * action_required, which a branch protection does not pass; 'neutral' is the
 * org's fallback to the earlier behavior. The API validates the value; any
 * other value reads as null.
 */
export class AddRuntimePartlyTestedCheck2026111800000010 implements MigrationInterface {
    name = 'AddRuntimePartlyTestedCheck2026111800000010';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" ADD COLUMN IF NOT EXISTS "partly_tested_check" character varying(32)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" DROP COLUMN IF EXISTS "partly_tested_check"`);
    }
}
