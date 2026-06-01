import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Engine
import { PipelineStateManager } from '../engine/state/pipeline-state-manager.service';
import { EventBufferService } from '../engine/event-buffer.service';

// Infrastructure - Services
import { DistributedLockService } from '../infrastructure/distributed-lock.service';

// Infrastructure - Repositories & Models
import { WorkflowJobModel } from '../infrastructure/repositories/schemas/workflow-job.model';
import { WorkflowJobRepository } from '../infrastructure/repositories/workflow-job.repository';
import { OutboxMessageModel } from '../infrastructure/repositories/schemas/outbox-message.model';
import { OutboxMessageRepository } from '../infrastructure/repositories/outbox-message.repository';
import { InboxMessageModel } from '../infrastructure/repositories/schemas/inbox-message.model';
import { InboxMessageRepository } from '../infrastructure/repositories/inbox-message.repository';
import { JobStatusService } from '../infrastructure/job-status.service';

// Domain contracts
import { JOB_STATUS_SERVICE_TOKEN } from '../domain/contracts/job-status.service.contract';
import { WORKFLOW_JOB_REPOSITORY_TOKEN } from '../domain/contracts/workflow-job.repository.contract';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '../domain/contracts/outbox-message.repository.contract';
import { INBOX_MESSAGE_REPOSITORY_TOKEN } from '../domain/contracts/inbox-message.repository.contract';

const coreProviders = [
    // Repositories
    WorkflowJobRepository,
    {
        provide: WORKFLOW_JOB_REPOSITORY_TOKEN,
        useClass: WorkflowJobRepository,
    },
    OutboxMessageRepository,
    {
        provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
        useClass: OutboxMessageRepository,
    },
    InboxMessageRepository,
    {
        provide: INBOX_MESSAGE_REPOSITORY_TOKEN,
        useClass: InboxMessageRepository,
    },

    // Infrastructure Services
    {
        provide: JOB_STATUS_SERVICE_TOKEN,
        useClass: JobStatusService,
    },

    // Engine
    PipelineStateManager,
    EventBufferService,

    // Distributed Lock
    DistributedLockService,
];

@Global()
@Module({
    imports: [
        TypeOrmModule.forFeature([
            WorkflowJobModel,
            OutboxMessageModel,
            InboxMessageModel,
        ]),
    ],
    providers: [...coreProviders],
    exports: [...coreProviders, TypeOrmModule],
})
export class WorkflowCoreModule {}
