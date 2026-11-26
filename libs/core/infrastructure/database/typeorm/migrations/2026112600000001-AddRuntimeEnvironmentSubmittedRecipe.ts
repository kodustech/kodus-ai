import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime (docs/runtime/environment-setup.md section 3): the recipe a developer's own coding agent sent through a team key
 * (env_recipe_submit, the Kodus CLI), set up from while the default branch has no recipe. Null: none sent, every existing
 * environment keeps behaving as it does.
 */
export class AddRuntimeEnvironmentSubmittedRecipe2026112600000001 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentSubmittedRecipe2026112600000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "submitted_recipe" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "submitted_recipe"`);
    }
}
