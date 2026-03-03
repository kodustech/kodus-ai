import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCodeReviewMaxFilesEnum1771600000000
  implements MigrationInterface
{
  name = 'AddCodeReviewMaxFilesEnum1771600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "public"."organization_parameters_configkey_enum"
      ADD VALUE IF NOT EXISTS 'code_review_max_files'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠ PostgreSQL does NOT support removing enum values
    // Down migration cannot safely remove this value.
  }
}