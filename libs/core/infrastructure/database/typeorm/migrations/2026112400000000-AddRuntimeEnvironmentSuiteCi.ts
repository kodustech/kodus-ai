import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime e2e suites (docs/runtime/e2e-suites.md section 13): whether an environment runs its repository's own suite on every push
 * as a CI check. Null follows the deployment's default (RUNTIME_SUITE_CI), so every existing environment keeps behaving as it does.
 */
export class AddRuntimeEnvironmentSuiteCi2026112400000000 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentSuiteCi2026112400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "suite_ci" boolean`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "suite_ci"`);
    }
}
