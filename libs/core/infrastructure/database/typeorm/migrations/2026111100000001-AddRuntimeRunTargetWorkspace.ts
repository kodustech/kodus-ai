import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the commits every repository of a multi-repository Run ran
 * at, pinned when the product requested it, so the report names them and
 * Run again boots the same ones. Null for a Run of one repository.
 */
export class AddRuntimeRunTargetWorkspace2026111100000001 implements MigrationInterface {
    name = 'AddRuntimeRunTargetWorkspace2026111100000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_run_targets" ADD COLUMN IF NOT EXISTS "workspace" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_run_targets" DROP COLUMN IF EXISTS "workspace"`);
    }
}
