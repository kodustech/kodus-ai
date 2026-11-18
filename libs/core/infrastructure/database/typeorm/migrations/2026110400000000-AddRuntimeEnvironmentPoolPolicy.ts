import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: when an environment keeps its machines ready (libs/runtime/api/domain/pool.ts).
 * pool_policy: the admin's schedule, pull request warm-up and monthly budget (null: always).
 * pool_activity_at: the last pull request event. pool_applied_size and pool_usage: what the
 * scheduler last asked the cell for and the month's estimated machine-minutes.
 */
export class AddRuntimeEnvironmentPoolPolicy2026110400000000 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentPoolPolicy2026110400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "pool_policy" jsonb NULL`);
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "pool_activity_at" timestamptz NULL`);
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "pool_applied_size" integer NULL`);
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "pool_usage" jsonb NULL`);
        // The scheduler reads only the environments with a policy.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_environments_pool_policy" ON "runtime_environments" ((pool_policy IS NOT NULL)) WHERE pool_policy IS NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_runtime_environments_pool_policy"`);
        for (const c of ['pool_usage', 'pool_applied_size', 'pool_activity_at', 'pool_policy']) {
            await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "${c}"`);
        }
    }
}
