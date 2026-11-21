import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime preview URLs, phase 2 (docs/runtime/preview-urls.md §15):
 * the org's preview settings (null: the defaults, on where the deployment
 * has a preview domain), an environment's secrets in its previews (none by
 * default, decision 4), and whether a Run's pull request is a fork's (the
 * comment says why its PR side has no preview; null on older targets).
 */
export class AddRuntimePreviewSettings2026111400000000 implements MigrationInterface {
    name = 'AddRuntimePreviewSettings2026111400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" ADD COLUMN IF NOT EXISTS "preview" jsonb`);
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "preview_secrets" character varying(8) NOT NULL DEFAULT 'none'`);
        await queryRunner.query(`ALTER TABLE "runtime_run_targets" ADD COLUMN IF NOT EXISTS "fork" boolean`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_run_targets" DROP COLUMN IF EXISTS "fork"`);
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "preview_secrets"`);
        await queryRunner.query(`ALTER TABLE "runtime_settings" DROP COLUMN IF EXISTS "preview"`);
    }
}
