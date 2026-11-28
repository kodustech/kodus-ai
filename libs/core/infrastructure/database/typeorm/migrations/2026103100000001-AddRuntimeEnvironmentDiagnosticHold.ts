import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the org admin's diagnostic hold per environment (§11 runbook
 * "Setup falha e o Blocker não explica"). Off by default.
 */
export class AddRuntimeEnvironmentDiagnosticHold2026103100000001 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentDiagnosticHold2026103100000001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "diagnostic_hold" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "diagnostic_hold"`);
    }
}
