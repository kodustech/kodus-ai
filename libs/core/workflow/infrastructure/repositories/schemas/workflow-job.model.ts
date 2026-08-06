import { Column, Entity, Index, OneToMany } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import type { OutboxMessageModel } from './outbox-message.model';
import type { InboxMessageModel } from './inbox-message.model';

@Entity({ name: 'workflow_jobs', schema: 'kodus_workflow' })
@Index('IDX_workflow_jobs_status', ['status'])
@Index('IDX_workflow_jobs_workflow_type', ['workflowType'])
@Index('IDX_workflow_jobs_correlation_id', ['correlationId'])
@Index('IDX_workflow_jobs_organization_team', ['organizationId', 'teamId'])
@Index('idx_workflow_jobs_type_updated', ['workflowType', 'updatedAt'])
// Partial covering index for the WebhookFailureMonitorService cron —
// `COUNT(*) FILTER (status=...) FROM workflow_jobs WHERE workflowType
// ='WEBHOOK_PROCESSING' AND updatedAt >= now()-30min`. The composite
// above forced a Bitmap Heap Scan (3-16s in prod); this partial with
// `status` in the key turns it into an Index Only Scan (measured 14×
// faster). TypeORM cannot emit the DESC ordering or the WHERE clause,
// so `synchronize: false` and the real CREATE lives in migration
// CronPoolReliefIndexes2026080600000000.
@Index('idx_workflow_jobs_webhook_monitor', { synchronize: false })
export class WorkflowJobModel extends CoreModel {
    @Column({ type: 'varchar', length: 255 })
    correlationId: string;

    @Column({
        type: 'enum',
        enum: WorkflowType,
    })
    workflowType: WorkflowType;

    @Column({
        type: 'enum',
        enum: HandlerType,
    })
    handlerType: HandlerType;

    @Column({ type: 'jsonb', default: {} })
    payload: Record<string, unknown>;

    @Column({
        type: 'enum',
        enum: JobStatus,
        default: JobStatus.PENDING,
    })
    status: JobStatus;

    @Column({ type: 'int', default: 0 })
    priority: number;

    @Column({ type: 'int', default: 0 })
    retryCount: number;

    @Column({ type: 'int', default: 3 })
    maxRetries: number;

    @Column({ type: 'varchar', length: 255, nullable: true })
    organizationId?: string;

    @Column({ type: 'varchar', length: 255, nullable: true })
    teamId?: string;

    @Column({
        type: 'enum',
        enum: ErrorClassification,
        nullable: true,
    })
    errorClassification?: ErrorClassification;

    @Column({ type: 'text', nullable: true })
    lastError?: string;

    @Column({ type: 'timestamp', nullable: true })
    scheduledAt?: Date;

    @Column({ type: 'timestamp', nullable: true })
    startedAt?: Date;

    @Column({ type: 'timestamp', nullable: true })
    completedAt?: Date;

    @Column({ type: 'varchar', length: 255, nullable: true })
    currentStage?: string;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, unknown>;

    @Column({ type: 'jsonb', nullable: true })
    waitingForEvent?: {
        eventType: string;
        eventKey: string;
        timeout: number;
        pausedAt: Date;
    };

    @Column({ type: 'jsonb', nullable: true })
    pipelineState?: Record<string, unknown>;

    @OneToMany('OutboxMessageModel', 'job')
    outboxMessages?: OutboxMessageModel[];

    @OneToMany('InboxMessageModel', 'job')
    inboxMessages?: InboxMessageModel[];
}
