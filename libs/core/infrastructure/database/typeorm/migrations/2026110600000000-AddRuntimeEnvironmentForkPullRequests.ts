import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: what an environment does with a pull request from a fork
 * (libs/runtime/contracts/enums.ts FORK_PULL_REQUEST_POLICIES). Existing rows
 * get the safe default: a maintainer approves each fork head (ADR-030).
 */
export class AddRuntimeEnvironmentForkPullRequests2026110600000000 implements MigrationInterface {
    name = 'AddRuntimeEnvironmentForkPullRequests2026110600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "runtime_environments" ADD COLUMN IF NOT EXISTS "fork_pull_requests" character varying(32) NOT NULL DEFAULT 'require_approval'`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runtime_environments" DROP COLUMN IF EXISTS "fork_pull_requests"`);
    }
}
