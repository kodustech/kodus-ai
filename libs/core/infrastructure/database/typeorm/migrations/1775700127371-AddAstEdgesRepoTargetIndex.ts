import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAstEdgesRepoTargetIndex1775700127371 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS idx_ast_edges_repo_target ON ast_edges (repo_id, target_qualified)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS idx_ast_edges_repo_target`,
        );
    }
}
