import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the org admin's warm pool size per environment. Null keeps
 * the plan's default; the plan's ceiling bounds it (RUNTIME_POOL_MAX_SIZE).
 */
export class AddRuntimeEnvironmentPoolSize2026110300000000 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentPoolSize2026110300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "pool_size" integer NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "pool_size"`);
    }
}
