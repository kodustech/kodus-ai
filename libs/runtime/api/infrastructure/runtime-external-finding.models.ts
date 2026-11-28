import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ExternalSubmissionRecord } from '../domain/external-findings';

/** Product admission records; the Runtime workflow/projection are never written here. */
@Entity('runtime_external_submissions')
@Index(
    'UQ_runtime_external_fingerprint',
    ['organizationId', 'keyId', 'fingerprint'],
    { unique: true },
)
@Index('UQ_runtime_external_verification_task', ['verificationTaskId'], {
    unique: true,
})
@Index('IDX_runtime_external_quota', ['organizationId', 'createdAt'])
@Index('IDX_runtime_external_org_pending', { synchronize: false })
@Index('IDX_runtime_external_org_terminal', { synchronize: false })
@Index('IDX_runtime_external_pending', { synchronize: false })
@Index('IDX_runtime_external_terminal', { synchronize: false })
@Index('IDX_runtime_external_finding_ids', { synchronize: false })
export class RuntimeExternalSubmissionModel {
    @PrimaryColumn('uuid', { name: 'receipt_id' }) receiptId: string;
    @Column('uuid', { name: 'verification_task_id' })
    verificationTaskId: string;
    @Column('varchar', { name: 'organization_id', length: 128 })
    organizationId: string;
    @Column('varchar', { name: 'key_id', length: 128 }) keyId: string;
    @Column('varchar', { name: 'repository_id', length: 128 })
    repositoryId: string;
    @Column('integer', { name: 'pr_number' }) prNumber: number;
    @Column('varchar', { length: 64 }) fingerprint: string;
    @Column('uuid', { name: 'finding_ids', array: true }) findingIds: string[];
    @Column('integer', { name: 'finding_count' }) findingCount: number;
    @Column('timestamptz', { name: 'created_at' }) createdAt: Date;
    @Column('timestamptz', { name: 'expires_at' }) expiresAt: Date;
    @Column('timestamptz', { name: 'terminal_at', nullable: true })
    terminalAt: Date | null;
    @Column('jsonb') record: ExternalSubmissionRecord;
}

@Entity('runtime_external_message_keys')
@Index('IDX_runtime_external_receipt_alias', [
    'organizationId',
    'receiptId',
    'createdAt',
])
@Index('IDX_runtime_external_message_quota', [
    'organizationId',
    'keyId',
    'createdAt',
])
export class RuntimeExternalMessageModel {
    @PrimaryColumn('varchar', { name: 'organization_id', length: 128 })
    organizationId: string;
    @PrimaryColumn('varchar', { name: 'key_id', length: 128 }) keyId: string;
    @PrimaryColumn('varchar', { name: 'message_id', length: 128 })
    messageId: string;
    @Column('varchar', { name: 'body_hash', length: 64 }) bodyHash: string;
    @Column('uuid', { name: 'receipt_id' }) receiptId: string;
    @Column('timestamptz', { name: 'created_at' }) createdAt: Date;
}
