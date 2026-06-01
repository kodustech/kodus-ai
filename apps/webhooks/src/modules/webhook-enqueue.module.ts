import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkflowQueueLoader } from '@libs/core/infrastructure/config/loaders/workflow-queue.loader';

import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WORKFLOW_JOB_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { OutboxMessageRepository } from '@libs/core/workflow/infrastructure/repositories/outbox-message.repository';
import { OutboxMessageModel } from '@libs/core/workflow/infrastructure/repositories/schemas/outbox-message.model';

@Module({
    imports: [
        ConfigModule.forFeature(WorkflowQueueLoader),
        TypeOrmModule.forFeature([WorkflowJobModel, OutboxMessageModel]),
    ],
    providers: [
        WorkflowJobRepository,
        OutboxMessageRepository,
        {
            provide: WORKFLOW_JOB_REPOSITORY_TOKEN,
            useClass: WorkflowJobRepository,
        },
        {
            provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
            useClass: OutboxMessageRepository,
        },
        {
            provide: JOB_QUEUE_SERVICE_TOKEN,
            useClass: WorkflowJobQueueService,
        },
        EnqueueWebhookUseCase,
    ],
    exports: [EnqueueWebhookUseCase, JOB_QUEUE_SERVICE_TOKEN],
})
export class WebhookEnqueueModule {}
