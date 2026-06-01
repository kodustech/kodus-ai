import {
    RabbitSubscribe,
    MessageHandlerErrorBehavior,
} from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import { Injectable, Inject } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import * as os from 'os';

import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '../domain/contracts/workflow-job.repository.contract';
import { PipelineStateManager } from './state/pipeline-state-manager.service';
import { EventBufferService } from './event-buffer.service';
import { StageCompletedEvent } from '../domain/interfaces/stage-completed-event.interface';
import { JobStatus } from '../domain/enums/job-status.enum';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import { InboxStatus } from '../infrastructure/repositories/schemas/inbox-message.model';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';

/**
 * Generic handler for heavy stage completion events
 * Resumes paused workflows when events arrive
 */
@Injectable()
export class HeavyStageEventHandler {
    private readonly logger = createLogger(HeavyStageEventHandler.name);
    private readonly consumerId = 'workflow-events-stage-completed';
    private readonly instanceId = os.hostname();

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly stateManager: PipelineStateManager,
        private readonly eventBuffer: EventBufferService,
        private readonly observability: ObservabilityService,
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
    ) {}

    /**
     * Handle stage completion event
     * Finds paused workflows waiting for this event and resumes them
     */
    @RabbitSubscribe({
        exchange: 'workflow.events',
        routingKey: 'stage.completed.*',
        queue: 'workflow.events.stage.completed',
        allowNonJsonMessages: false,
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.events.dlq',
        ),
        queueOptions: {
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.events.dlx',
                'x-dead-letter-routing-key': 'workflow.events.dlq',
            },
        },
    })
    @RabbitSubscribe({
        exchange: 'workflow.events.delayed',
        routingKey: 'stage.completed.*',
        queue: 'workflow.events.stage.completed',
        allowNonJsonMessages: false,
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.events.dlq',
        ),
        queueOptions: {
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.events.dlx',
                'x-dead-letter-routing-key': 'workflow.events.dlq',
            },
        },
    })
    async onStageCompleted(
        event: StageCompletedEvent,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        const messageId =
            amqpMsg.properties.messageId ||
            `stage.completed:${event.eventType}:${event.eventKey}:${event.taskId}`;
        const correlationId =
            (amqpMsg.properties.headers &&
                amqpMsg.properties.headers['x-correlation-id']) ||
            amqpMsg.properties.correlationId;

        const claimed = await this.inboxRepository.claim(
            messageId,
            this.consumerId,
            this.instanceId,
        );

        if (!claimed) {
            const existing =
                await this.inboxRepository.findByConsumerAndMessageId(
                    this.consumerId,
                    messageId,
                );

            if (existing?.status === InboxStatus.PROCESSED) {
                this.logger.debug({
                    message: 'Message already processed (Idempotency skip)',
                    context: HeavyStageEventHandler.name,
                    metadata: { messageId, correlationId },
                });
                return;
            }

            this.logger.warn({
                message:
                    'Message already claimed by another worker, retrying with backoff',
                context: HeavyStageEventHandler.name,
                metadata: { messageId, correlationId },
            });
            throw new Error('Message already claimed but not finished');
        }

        return await this.observability.runInSpan(
            'workflow.event.stage.completed',
            async (span) => {
                try {
                    span.setAttributes({
                        'workflow.event.type': event.eventType,
                        'workflow.event.stage': event.stageName,
                        'workflow.event.task.id': event.taskId,
                        'workflow.correlation.id': correlationId,
                    });

                    this.logger.log({
                        message: `Received stage completion event: ${event.stageName}`,
                        context: HeavyStageEventHandler.name,
                        metadata: {
                            stageName: event.stageName,
                            eventType: event.eventType,
                            eventKey: event.eventKey,
                            taskId: event.taskId,
                            messageId,
                            correlationId,
                        },
                    });

                    // Find workflows waiting for this event
                    const waitingJobs = await this.findWaitingWorkflows(
                        event.eventType,
                        event.eventKey,
                    );

                    if (waitingJobs.length === 0) {
                        // Store event in buffer for potential race conditions
                        await this.eventBuffer.store(
                            event.eventType,
                            event.eventKey,
                            event,
                        );
                        this.logger.warn({
                            message: `No workflows found waiting for event ${event.eventType} with key ${event.eventKey}`,
                            context: HeavyStageEventHandler.name,
                            metadata: {
                                eventType: event.eventType,
                                eventKey: event.eventKey,
                                taskId: event.taskId,
                            },
                        });

                        await this.inboxRepository.markAsProcessed(
                            messageId,
                            this.consumerId,
                        );
                        return;
                    }

                    // Resume each waiting workflow
                    for (const job of waitingJobs) {
                        try {
                            await this.resumeWorkflow(job.id, event);
                        } catch (error) {
                            this.logger.error({
                                message: `Failed to resume workflow ${job.id}`,
                                context: HeavyStageEventHandler.name,
                                error:
                                    error instanceof Error ? error : undefined,
                                metadata: {
                                    workflowJobId: job.id,
                                    stageName: event.stageName,
                                    eventType: event.eventType,
                                    taskId: event.taskId,
                                },
                            });
                            // Continue with other workflows even if one fails
                        }
                    }

                    await this.inboxRepository.markAsProcessed(
                        messageId,
                        this.consumerId,
                    );
                } catch (error) {
                    span.setAttributes({
                        'error': true,
                        'exception.type': error.name,
                        'exception.message': error.message,
                    });

                    await this.inboxRepository.releaseLock(
                        messageId,
                        this.consumerId,
                        error.message,
                    );
                    throw error;
                }
            },
        );
    }

    /**
     * Find workflows waiting for a specific event
     */
    private async findWaitingWorkflows(eventType: string, eventKey: string) {
        const allWaitingJobs = await this.jobRepository.findMany({
            status: JobStatus.WAITING_FOR_EVENT,
            limit: 1000, // Reasonable limit
        });

        return allWaitingJobs.data.filter((job) => {
            const waitingFor = job.waitingForEvent;
            return (
                waitingFor?.eventType === eventType &&
                waitingFor?.eventKey === eventKey
            );
        });
    }

    /**
     * Resume a paused workflow
     * Updates job status and enqueues for continued processing via workflow.jobs.* consumer
     */
    private async resumeWorkflow(
        workflowJobId: string,
        event: StageCompletedEvent,
    ): Promise<void> {
        const job = await this.jobRepository.findOne(workflowJobId);
        if (!job) {
            this.logger.warn({
                message: `Job ${workflowJobId} not found when trying to resume workflow`,
                context: HeavyStageEventHandler.name,
                metadata: { workflowJobId },
            });
            return;
        }

        this.logger.log({
            message: `Resuming workflow ${workflowJobId} for stage ${event.stageName}`,
            context: HeavyStageEventHandler.name,
            metadata: {
                workflowJobId,
                stageName: event.stageName,
                eventType: event.eventType,
                taskId: event.taskId,
                correlationId: job.correlationId,
            },
        });

        // Update job to resume processing
        await this.jobRepository.update(workflowJobId, {
            status: JobStatus.PENDING, // Back to queue
            waitingForEvent: undefined, // Clear waiting state
            metadata: {
                ...job.metadata,
                stageCompletedEvent: {
                    stageName: event.stageName,
                    eventType: event.eventType,
                    eventKey: event.eventKey,
                    taskId: event.taskId,
                    result: event.result,
                },
                resumedAt: new Date(),
            },
        });

        const payload = {
            jobId: workflowJobId,
            eventData: {
                stageName: event.stageName,
                eventType: event.eventType,
                taskId: event.taskId,
                result: event.result,
            },
        };
        const messageId = `resume-${workflowJobId}-${event.eventType}-${event.taskId}`;

        await this.messageBroker.publishMessage(
            {
                exchange: 'workflow.exchange',
                routingKey: `workflow.jobs.resumed.${job.workflowType}`,
            },
            {
                event_name: 'workflow.jobs.resumed',
                event_version: 1,
                occurred_on: new Date(),
                payload: payload,
                messageId: messageId,
            },
            {
                messageId: messageId,
                correlationId: job.correlationId,
                persistent: true,
                headers: {
                    'x-correlation-id': job.correlationId,
                    'x-workflow-type': job.workflowType,
                    'x-job-id': workflowJobId,
                    'x-resume-reason': event.eventType,
                    'x-stage-name': event.stageName,
                },
            },
        );

        this.logger.log({
            message: `Workflow ${workflowJobId} enqueued for resume after ${event.stageName} completion`,
            context: HeavyStageEventHandler.name,
            metadata: {
                workflowJobId,
                stageName: event.stageName,
                correlationId: job.correlationId,
                taskId: event.taskId,
            },
        });
    }
}
