import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRuntimeExternalFindings2026110800000000 implements MigrationInterface {
    name = 'CreateRuntimeExternalFindings2026110800000000';
    async up(q: QueryRunner): Promise<void> {
        await q.query(`CREATE TABLE IF NOT EXISTS runtime_external_submissions (
            receipt_id uuid PRIMARY KEY,
            verification_task_id uuid NOT NULL,
            organization_id varchar(128) NOT NULL,
            key_id varchar(128) NOT NULL,
            repository_id varchar(128) NOT NULL,
            pr_number integer NOT NULL CHECK (pr_number > 0),
            fingerprint varchar(64) NOT NULL,
            finding_ids uuid[] NOT NULL,
            finding_count integer NOT NULL CHECK (finding_count BETWEEN 1 AND 10),
            created_at timestamptz NOT NULL,
            record jsonb NOT NULL,
            CONSTRAINT "UQ_runtime_external_verification_task" UNIQUE (verification_task_id),
            CONSTRAINT "UQ_runtime_external_fingerprint" UNIQUE (organization_id,key_id,fingerprint)
        )`);
        await q.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_external_quota" ON runtime_external_submissions (organization_id,created_at)`,
        );
        await q.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_external_finding_ids" ON runtime_external_submissions USING GIN(finding_ids)`,
        );
        await q.query(`CREATE TABLE IF NOT EXISTS runtime_external_message_keys (
            organization_id varchar(128) NOT NULL,
            key_id varchar(128) NOT NULL,
            message_id varchar(128) NOT NULL,
            body_hash varchar(64) NOT NULL,
            created_at timestamptz NOT NULL,
            receipt_id uuid NOT NULL REFERENCES runtime_external_submissions(receipt_id) ON DELETE CASCADE,
            PRIMARY KEY(organization_id,key_id,message_id)
        )`);
        await q.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_external_message_quota" ON runtime_external_message_keys (organization_id,key_id,created_at)`,
        );
    }
    async down(q: QueryRunner): Promise<void> {
        await q.query('DROP TABLE IF EXISTS runtime_external_message_keys');
        await q.query('DROP TABLE IF EXISTS runtime_external_submissions');
    }
}
