import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import type { WorkflowJobModel } from './workflow-job.model';

export enum InboxStatus {
    READY = 'READY',
    PROCESSING = 'PROCESSING',
    PROCESSED = 'PROCESSED',
    FAILED = 'FAILED',
}

@Entity({ name: 'inbox_messages', schema: 'kodus_workflow' })
// FK lookup index for deletes on workflow_jobs; built CONCURRENTLY in
// migration WorkflowJobsRetentionIndexes2026111710000000.
@Index('IDX_inbox_messages_job_id', { synchronize: false })
@Index('IDX_inbox_messages_status', ['status'])
@Index('IDX_inbox_messages_next_attempt_at', ['nextAttemptAt'])
@Index('IDX_inbox_messages_created_at', ['createdAt'])
@Index('IDX_inbox_messages_consumer_message', ['consumerId', 'messageId'], {
    unique: true,
})
@Index('IDX_inbox_messages_locked_at', ['lockedAt'])
@Index('IDX_inbox_messages_consumer_status_locked', [
    'consumerId',
    'status',
    'lockedAt',
])
export class InboxMessageModel extends CoreModel {
    @Column({ type: 'varchar', length: 255 })
    messageId: string;

    @Column({ type: 'varchar', length: 255, default: 'default' })
    consumerId: string;

    @ManyToOne('WorkflowJobModel', 'inboxMessages', {
        nullable: true,
    })
    @JoinColumn({ name: 'job_id', referencedColumnName: 'uuid' })
    job?: WorkflowJobModel;

    @Column({
        type: 'enum',
        enum: InboxStatus,
        default: InboxStatus.READY,
    })
    status: InboxStatus;

    @Column({ type: 'int', default: 0 })
    attempts: number;

    @Column({
        type: 'timestamp',
        default: () => 'CURRENT_TIMESTAMP',
    })
    nextAttemptAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    lockedAt?: Date;

    @Column({ type: 'varchar', length: 255, nullable: true })
    lockedBy?: string;

    @Column({ type: 'text', nullable: true })
    lastError?: string;

    @Column({ type: 'timestamp', nullable: true })
    processedAt?: Date;
}
