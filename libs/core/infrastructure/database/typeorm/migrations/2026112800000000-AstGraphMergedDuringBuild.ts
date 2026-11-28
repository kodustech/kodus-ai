import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the latest merge that arrived while a full graph build ran, so the
 * build can enqueue one catch-up incremental when it publishes.
 */
export class AstGraphMergedDuringBuild2026112800000000 implements MigrationInterface {
    name = 'AstGraphMergedDuringBuild2026112800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "ast_graph_merged_during_build" text`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "repositories" DROP COLUMN IF EXISTS "ast_graph_merged_during_build"`,
        );
    }
}
