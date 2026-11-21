import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime cost on the org's own hosts: what one hour of its host costs,
 * in US$, set in Runtime settings. With it, the machine time of the org's
 * own cells is priced (a Run's cost, the Health card, the usage report).
 * Null, the default, leaves those machines unpriced. The API takes a value
 * above 0 and at most 1 000; a value outside it reads as null.
 */
export class AddRuntimeMachineUsdPerHostHour2026111720000000 implements MigrationInterface {
    name = 'AddRuntimeMachineUsdPerHostHour2026111720000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" ADD COLUMN IF NOT EXISTS "machine_usd_per_host_hour" numeric(12,6)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_settings" DROP COLUMN IF EXISTS "machine_usd_per_host_hour"`);
    }
}
