import {
    RabbitSubscribe,
    MessageHandlerErrorBehavior,
} from '@golevelup/nestjs-rabbitmq';
import * as os from 'os';
import { Injectable, Inject } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';

import { createLogger } from '@kodus/flow';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import { InboxStatus } from './repositories/schemas/inbox-message.model';

import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '../domain/contracts/workflow-job.repository.contract';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';

interface ASTCompletedMessage {
    taskId: string;
    result: Record<string, unknown>;
}

@Injectable()
export class ASTEventHandler {
    private readonly logger = createLogger(ASTEventHandler.name);
    private readonly consumerId = 'workflow-events-ast';
    private readonly instanceId = os.hostname();

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        private readonly observability: ObservabilityService,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
    ) {}

    @RabbitSubscribe({
        exchange: 'workflow.events',
        routingKey: 'ast.task.completed',
        queue: 'workflow.events.ast',
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
        routingKey: 'ast.task.completed',
        queue: 'workflow.events.ast',
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
    async handleASTCompleted(
        message: ASTCompletedMessage,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        const messageId =
            amqpMsg.properties.messageId ||
            `ast.task.completed:${message.taskId}`;
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
                    context: ASTEventHandler.name,
                    metadata: { messageId, correlationId },
                });
                return;
            }

            this.logger.warn({
                message:
                    'Message already claimed by another worker, retrying with backoff',
                context: ASTEventHandler.name,
                metadata: { messageId, correlationId },
            });
            throw new Error('Message already claimed but not finished');
        }

        return await this.observability.runInSpan(
            'workflow.event.ast.completed',
            async (span) => {
                span.setAttributes({
                    'workflow.event.type': 'ast.task.completed',
                    'workflow.event.task.id': message.taskId,
                    'workflow.correlation.id': correlationId,
                });

                try {
                    this.logger.log({
                        message: 'Received AST completed event',
                        context: ASTEventHandler.name,
                        metadata: {
                            taskId: message.taskId,
                            messageId,
                            correlationId,
                        },
                    });

                    // Find workflows waiting for this AST task
                    const waitingJobsResult = await this.jobRepository.findMany(
                        {
                            status: JobStatus.WAITING_FOR_EVENT,
                        },
                    );

                    const matchingJobs = waitingJobsResult.data.filter(
                        (job) => {
                            const waitingFor = job.waitingForEvent;
                            return (
                                waitingFor?.eventType ===
                                    'ast.task.completed' &&
                                waitingFor?.eventKey === message.taskId
                            );
                        },
                    );

                    if (matchingJobs.length === 0) {
                        this.logger.debug({
                            message: `No workflows found waiting for AST task ${message.taskId}`,
                            context: ASTEventHandler.name,
                            metadata: { taskId: message.taskId },
                        });
                        await this.inboxRepository.markAsProcessed(
                            messageId,
                            this.consumerId,
                        );
                        return;
                    }

                    this.logger.log({
                        message: `Found ${matchingJobs.length} workflow(s) waiting for AST task ${message.taskId}`,
                        context: ASTEventHandler.name,
                        metadata: {
                            taskId: message.taskId,
                            jobIds: matchingJobs.map((j) => j.id),
                        },
                    });

                    for (const job of matchingJobs) {
                        await this.resumeWorkflow(job.id, {
                            astResult: message.result,
                            taskId: message.taskId,
                        });
                    }

                    span.setAttributes({
                        'workflow.event.resumed_count': matchingJobs.length,
                    });

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
            {
                'workflow.component': 'event_handler',
                'workflow.operation': 'resume_workflow',
            },
        );
    }

    /**
     * Resumes a paused workflow with event data.
     * Updates job status to PENDING and enqueues for continued processing.
     */
    private async resumeWorkflow(
        jobId: string,
        eventData: { astResult: Record<string, unknown>; taskId: string },
    ): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);
        if (!job) {
            this.logger.warn({
                message: `Job ${jobId} not found when trying to resume workflow`,
                context: ASTEventHandler.name,
                metadata: { jobId },
            });
            return;
        }

        // Update job to resume processing
        await this.jobRepository.update(jobId, {
            status: JobStatus.PENDING, // Back to queue
            waitingForEvent: undefined, // Clear waiting state
            metadata: {
                ...job.metadata,
                astResult: eventData.astResult, // Save AST result
                resumedAt: new Date(),
            },
        });

        const payload = {
            jobId,
            eventData: eventData.astResult,
        };

        // Enqueue job for continued processing
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
                messageId: `resume-${jobId}`,
            },
            {
                messageId: `resume-${jobId}`,
                correlationId: job.correlationId,
                persistent: true,
                headers: {
                    'x-correlation-id': job.correlationId,
                    'x-workflow-type': job.workflowType,
                    'x-job-id': jobId,
                    'x-resume-reason': 'ast.completed',
                },
            },
        );

        this.logger.log({
            message: `Workflow ${jobId} resumed after AST completion`,
            context: ASTEventHandler.name,
            metadata: {
                jobId,
                correlationId: job.correlationId,
                taskId: eventData.taskId,
            },
        });
    }
}
