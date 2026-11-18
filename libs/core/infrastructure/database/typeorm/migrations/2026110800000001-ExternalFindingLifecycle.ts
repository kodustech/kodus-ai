import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive product-only lifecycle indexes; no Runtime database mutation. Idempotent, like the other Runtime migrations. */
export class ExternalFindingLifecycle2026110800000001 implements MigrationInterface {
    name = 'ExternalFindingLifecycle2026110800000001';
    async up(q: QueryRunner): Promise<void> {
        await q.query(
            'ALTER TABLE runtime_external_submissions ADD COLUMN IF NOT EXISTS expires_at timestamptz, ADD COLUMN IF NOT EXISTS terminal_at timestamptz',
        );
        await q.query(`UPDATE runtime_external_submissions SET expires_at=(record->>'expiresAt')::timestamptz,
            terminal_at=CASE WHEN record->'terminal' IS NOT NULL THEN (record#>>'{terminal,updatedAt}')::timestamptz WHEN record->'refusal' IS NOT NULL THEN created_at ELSE NULL END`);
        await q.query(
            'ALTER TABLE runtime_external_submissions ALTER COLUMN expires_at SET NOT NULL',
        );
        await q.query(
            'CREATE INDEX IF NOT EXISTS "IDX_runtime_external_pending" ON runtime_external_submissions(expires_at,receipt_id,organization_id) WHERE terminal_at IS NULL',
        );
        await q.query(
            'CREATE INDEX IF NOT EXISTS "IDX_runtime_external_terminal" ON runtime_external_submissions(terminal_at,receipt_id,organization_id) WHERE terminal_at IS NOT NULL',
        );
        await q.query(
            'CREATE INDEX IF NOT EXISTS "IDX_runtime_external_org_pending" ON runtime_external_submissions(organization_id,expires_at,receipt_id) WHERE terminal_at IS NULL',
        );
        await q.query(
            'CREATE INDEX IF NOT EXISTS "IDX_runtime_external_org_terminal" ON runtime_external_submissions(organization_id,terminal_at,receipt_id) WHERE terminal_at IS NOT NULL',
        );
        await q.query(
            'CREATE INDEX IF NOT EXISTS "IDX_runtime_external_receipt_alias" ON runtime_external_message_keys(organization_id,receipt_id,created_at)',
        );
    }
    async down(q: QueryRunner): Promise<void> {
        await q.query('DROP INDEX IF EXISTS "IDX_runtime_external_receipt_alias"');
        await q.query('DROP INDEX IF EXISTS "IDX_runtime_external_org_terminal"');
        await q.query('DROP INDEX IF EXISTS "IDX_runtime_external_org_pending"');
        await q.query('DROP INDEX IF EXISTS "IDX_runtime_external_terminal"');
        await q.query('DROP INDEX IF EXISTS "IDX_runtime_external_pending"');
        await q.query(
            'ALTER TABLE runtime_external_submissions DROP COLUMN IF EXISTS terminal_at, DROP COLUMN IF EXISTS expires_at',
        );
    }
}
