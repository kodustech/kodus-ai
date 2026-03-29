import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLicenseKeyParams1772500000000 implements MigrationInterface {
    name = 'AddLicenseKeyParams1772500000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum"
            ADD VALUE IF NOT EXISTS 'license_key'
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum"
            ADD VALUE IF NOT EXISTS 'license_assigned_users'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing values from an enum.
        // A full rename-recreate approach would risk data loss if rows
        // reference these values, so we leave them in place.
    }
}
