import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import type { WorkflowJobModel } from './workflow-job.model';

export enum OutboxStatus {
    READY = 'READY',
    PROCESSING = 'PROCESSING',
    SENT = 'SENT',
    FAILED = 'FAILED',
}

@Entity({ name: 'outbox_messages', schema: 'kodus_workflow' })
// FK lookup index for deletes on workflow_jobs; built CONCURRENTLY in
// migration WorkflowJobsRetentionIndexes2026111710000000.
@Index('IDX_outbox_messages_job_id', { synchronize: false })
@Index('IDX_outbox_messages_status', ['status'])
@Index('IDX_outbox_messages_next_attempt_at', ['nextAttemptAt'])
@Index('IDX_outbox_messages_created_at', ['createdAt'])
@Index('IDX_outbox_messages_locked_at', ['lockedAt'])
@Index('IDX_outbox_messages_status_created', ['status', 'createdAt'])
export class OutboxMessageModel extends CoreModel {
    @ManyToOne('WorkflowJobModel', 'outboxMessages', {
        nullable: true,
    })
    @JoinColumn({ name: 'job_id', referencedColumnName: 'uuid' })
    job?: WorkflowJobModel;

    @Column({ type: 'varchar', length: 255 })
    exchange: string;

    @Column({ type: 'varchar', length: 255 })
    routingKey: string;

    @Column({ type: 'jsonb' })
    payload: Record<string, unknown>;

    @Column({
        type: 'enum',
        enum: OutboxStatus,
        default: OutboxStatus.READY,
    })
    status: OutboxStatus;

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
