import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the org admin's machine size per environment (a preset of
 * libs/runtime/contracts/machine-size.ts). Null keeps the cell's default.
 */
export class AddRuntimeEnvironmentMachineSize2026110500000000 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentMachineSize2026110500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "machine_size" character varying(16) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "machine_size"`);
    }
}
