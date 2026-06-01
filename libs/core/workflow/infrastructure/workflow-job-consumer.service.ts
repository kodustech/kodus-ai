import * as os from 'os';
import {
    RabbitSubscribe,
    MessageHandlerErrorBehavior,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable, Inject, OnApplicationShutdown } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';

import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { JOB_PROCESSOR_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { createLogger } from '@kodus/flow';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import { InboxStatus } from './repositories/schemas/inbox-message.model';
import { createRabbitMQErrorHandlerWithFallback } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { runWithBoundedTimeout } from './run-with-bounded-timeout';
import {
    ITaskProtectionService,
    TASK_PROTECTION_SERVICE_TOKEN,
} from '../domain/contracts/task-protection.service.contract';

interface WorkflowJobMessage {
    jobId: string;
    correlationId?: string;
    [key: string]: unknown;
}

@Injectable()
export class WorkflowJobConsumer implements OnApplicationShutdown {
    private readonly logger = createLogger(WorkflowJobConsumer.name);
    private readonly instanceId = os.hostname();
    // Default ECS protection time in minutes
    private readonly JOB_PROTECTION_MINUTES = 60;
    private activeJobs = 0;

    constructor(
        @Inject(JOB_PROCESSOR_SERVICE_TOKEN)
        private readonly jobProcessor: IJobProcessorService,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly observability: ObservabilityService,
        @Inject(TASK_PROTECTION_SERVICE_TOKEN)
        private readonly taskProtectionService: ITaskProtectionService,
    ) {}

    /**
     * Webhook-processing jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.WEBHOOK_PROCESSING',
        queue: 'workflow.jobs.webhook.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-webhook',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleWebhookProcessingJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.webhook',
            'workflow.jobs.webhook.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * Code-review jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.CODE_REVIEW',
        queue: 'workflow.jobs.code_review.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-code-review',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleCodeReviewJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.code_review',
            'workflow.jobs.code_review.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * CLI code-review jobs
     * Separate queue from PR-driven CODE_REVIEW so CLI traffic spikes
     * don't starve PR reviews and vice versa.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.CLI_CODE_REVIEW',
        queue: 'workflow.jobs.cli_code_review.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-cli-code-review',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleCliCodeReviewJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.cli_code_review',
            'workflow.jobs.cli_code_review.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * Implementation Check jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.CHECK_SUGGESTION_IMPLEMENTATION',
        queue: 'workflow.jobs.check_implementation.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-check-implementation',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleImplementationCheckJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.check_implementation',
            'workflow.jobs.check_implementation.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * AST Graph Build jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     *
     * Uses Single Active Consumer so only ONE worker at a time pulls from
     * this queue (up to prefetchCount in-flight). Combined with
     * prefetchCount=5 on the channel, this caps global AST-build
     * concurrency at 5 across the cluster and frees the other workers to
     * serve other queues (code-review, webhook, etc). Failover is
     * automatic: if the active consumer dies, RabbitMQ promotes another.
     *
     * `x-consumer-timeout` is set to 25min (20min job timeout + 5min
     * overhead). If the active consumer holds a message unacked past
     * this window, RabbitMQ cancels it and promotes another — this
     * bounds the failover latency when a worker hangs (OOM, event-loop
     * stall) rather than crashing cleanly.
     *
     * NOTE: queue arguments are fixed at creation. To apply SAC /
     * consumer-timeout on an existing queue without recreating it, set a
     * broker policy with `single-active-consumer: true` and
     * `consumer-timeout: 1500000` matching this queue name.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.AST_GRAPH_BUILD',
        queue: 'workflow.jobs.ast_graph_build.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-ast-graph-build',
            arguments: {
                'x-queue-type': 'quorum',
                'x-single-active-consumer': true,
                'x-consumer-timeout': 25 * 60 * 1000,
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleAstGraphBuildJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.ast_graph_build',
            'workflow.jobs.ast_graph_build.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * AST Graph Incremental Update jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     *
     * Single Active Consumer + prefetchCount=5 caps global concurrency
     * at 5 — see handleAstGraphBuildJob for rationale.
     *
     * `x-consumer-timeout` set to 15min (10min job timeout + 5min
     * overhead) for tighter failover when a worker hangs.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.AST_GRAPH_INCREMENTAL',
        queue: 'workflow.jobs.ast_graph_incremental.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        ),
        queueOptions: {
            channel: 'channel-ast-graph-incremental',
            arguments: {
                'x-queue-type': 'quorum',
                'x-single-active-consumer': true,
                'x-consumer-timeout': 15 * 60 * 1000,
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleAstGraphIncrementalJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.ast_graph_incremental',
            'workflow.jobs.ast_graph_incremental.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * Inbox claim timeout per queue, in minutes. Dimensioned as
     * (workflow timeout + overhead) so a hard worker crash doesn't
     * block retries for the default 2.5h while we wait for the reaper.
     * Queues not listed fall back to 150 (2.5h).
     */
    private resolveClaimTimeoutMinutes(queueName: string): number {
        if (queueName === 'workflow.jobs.ast_graph_build.queue') return 30;
        if (queueName === 'workflow.jobs.ast_graph_incremental.queue')
            return 15;
        if (queueName === 'workflow.jobs.webhook.queue') return 20;
        if (queueName === 'workflow.jobs.cli_code_review.queue') return 35;
        return 150;
    }

    private async handleWorkflowJob(
        consumerId: string,
        queueName: string,
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        this.activeJobs++;
        try {
            await this.taskProtectionService.protectTask(
                this.JOB_PROTECTION_MINUTES,
            );
            return await this.processWorkflowJob(
                consumerId,
                queueName,
                message,
                amqpMsg,
            );
        } finally {
            await this.taskProtectionService.unprotectTask();
            this.activeJobs--;
        }
    }

    private async processWorkflowJob(
        consumerId: string,
        queueName: string,
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        const unwrappedMessage: WorkflowJobMessage = this.isMessagePayload(
            message,
        )
            ? message.payload
            : message;

        const messageId = amqpMsg.properties.messageId;
        const correlationId =
            (amqpMsg.properties.headers &&
                amqpMsg.properties.headers['x-correlation-id']) ||
            unwrappedMessage.correlationId ||
            amqpMsg.properties.correlationId;

        if (!messageId || !unwrappedMessage.jobId) {
            this.logger.error({
                message:
                    'Invalid workflow job message: missing messageId or jobId',
                context: WorkflowJobConsumer.name,
                metadata: {
                    message,
                    unwrappedMessage,
                    amqpMsg: {
                        messageId,
                        correlationId,
                        queueName,
                    },
                },
            });
            throw new Error('Invalid message: missing messageId or jobId');
        }

        // 1. Atomic claim in Inbox
        const claimed = await this.inboxRepository.claim(
            messageId,
            consumerId,
            this.instanceId,
            unwrappedMessage.jobId,
            this.resolveClaimTimeoutMinutes(queueName),
        );

        if (!claimed) {
            // If not claimed, it could be because it's already processed or being processed by another worker
            const existing =
                await this.inboxRepository.findByConsumerAndMessageId(
                    consumerId,
                    messageId,
                );

            if (existing?.status === InboxStatus.PROCESSED) {
                this.logger.debug({
                    message: 'Message already processed (Idempotency skip)',
                    context: WorkflowJobConsumer.name,
                    metadata: {
                        messageId,
                        jobId: unwrappedMessage.jobId,
                        queueName,
                    },
                });
                return;
            }

            // If it exists but isn't processed (and claim failed), throw error to trigger retry with backoff
            // Isso evita o hot loop de Nack(true) e respeita o delivery-limit das quorum queues
            this.logger.warn({
                message:
                    'Message already claimed by another worker, retrying with backoff',
                context: WorkflowJobConsumer.name,
                metadata: {
                    messageId,
                    jobId: unwrappedMessage.jobId,
                    queueName,
                },
            });
            throw new Error('Message already claimed but not finished');
        }

        // 2. Start observability span
        if (correlationId) {
            this.observability.setContext(correlationId);
        }

        return await this.observability.runInSpan(
            'workflow.job.consume',
            async (span) => {
                span.setAttributes({
                    'workflow.job.id': unwrappedMessage.jobId,
                    'workflow.correlation.id': correlationId,
                    'workflow.message.id': messageId,
                    'workflow.queue.name': queueName,
                });

                try {
                    await this.jobProcessor.process(unwrappedMessage.jobId);

                    await this.inboxRepository.markAsProcessed(
                        messageId,
                        consumerId,
                    );

                    span.setAttributes({
                        'workflow.job.processed': true,
                    });
                } catch (error) {
                    span.setAttributes({
                        'error': true,
                        'exception.type': error.name,
                        'exception.message': error.message,
                    });

                    this.logger.error({
                        message: 'Failed to process workflow job',
                        context: WorkflowJobConsumer.name,
                        error,
                        metadata: {
                            messageId,
                            jobId: unwrappedMessage.jobId,
                            correlationId,
                            queueName,
                        },
                    });

                    // CRITICAL: Always mark job as FAILED to prevent stuck PENDING jobs
                    try {
                        await this.jobRepository.update(
                            unwrappedMessage.jobId,
                            {
                                status: JobStatus.FAILED,
                                errorClassification:
                                    ErrorClassification.PERMANENT,
                                lastError: error.message,
                            },
                        );

                        this.logger.log({
                            message:
                                'Job marked as FAILED after processing error',
                            context: WorkflowJobConsumer.name,
                            metadata: {
                                jobId: unwrappedMessage.jobId,
                                error: error.message,
                            },
                        });
                    } catch (updateError) {
                        this.logger.error({
                            message: 'Failed to update job status to FAILED',
                            context: WorkflowJobConsumer.name,
                            error: updateError,
                            metadata: {
                                jobId: unwrappedMessage.jobId,
                                originalError: error.message,
                            },
                        });
                    }

                    // Release lock — bounded so a slow Mongo cannot keep the
                    // AMQP message unacked. If it times out or fails, the
                    // stale-claim reaper (claimTimeoutMinutes=150) reclaims it.
                    // Retry scheduling for AMQP is handled by RabbitMQErrorHandler.
                    try {
                        await runWithBoundedTimeout(
                            this.inboxRepository.releaseLock(
                                messageId,
                                consumerId,
                                error.message,
                            ),
                            10_000,
                            'inbox.releaseLock',
                        );
                    } catch (releaseErr) {
                        this.logger.error({
                            message:
                                'releaseLock failed/timed out; deferring to stale-claim reaper',
                            context: WorkflowJobConsumer.name,
                            error: releaseErr,
                            metadata: {
                                messageId,
                                jobId: unwrappedMessage.jobId,
                            },
                        });
                    }

                    // Re-throw so RabbitMQErrorHandler can republish with delay
                    throw error;
                }
            },
            {
                'workflow.component': 'consumer',
                'workflow.operation': 'process_job',
            },
        );
    }

    async onApplicationShutdown(signal?: string): Promise<void> {
        const rawDrain = process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        const parsedDrain = rawDrain ? parseInt(rawDrain, 10) : NaN;
        const maxWaitMs =
            Number.isFinite(parsedDrain) && parsedDrain > 0
                ? parsedDrain
                : 25_000; // safe fallback: dev/self-hosted default (30s ECS grace - 5s headroom)

        this.logger.log({
            message: `Shutdown signal ${signal} received. Waiting for active jobs...`,
            context: WorkflowJobConsumer.name,
            metadata: {
                activeJobs: this.activeJobs,
                maxWaitMs,
                drainTimeoutSource:
                    Number.isFinite(parsedDrain) && parsedDrain > 0
                        ? 'API_WORKER_DRAIN_TIMEOUT_MS'
                        : 'default_25s',
            },
        });

        const checkIntervalMs = 1_000;
        const waitStart = Date.now();

        while (this.activeJobs > 0 && Date.now() - waitStart < maxWaitMs) {
            this.logger.log({
                message: `Waiting for ${this.activeJobs} active jobs to complete...`,
                context: WorkflowJobConsumer.name,
            });
            await new Promise((resolve) =>
                setTimeout(resolve, checkIntervalMs),
            );
        }

        const drainDurationMs = Date.now() - waitStart;
        if (this.activeJobs > 0) {
            this.logger.warn({
                message: `Shutdown timeout reached with ${this.activeJobs} active jobs still running — releasing inbox locks anyway so other workers can reclaim the messages.`,
                context: WorkflowJobConsumer.name,
                metadata: {
                    activeJobs: this.activeJobs,
                    instanceId: this.instanceId,
                    drainDurationMs,
                    drainBudgetMs: maxWaitMs,
                    drainBudgetExhausted: true,
                },
            });
        } else {
            this.logger.log({
                message: 'All active jobs drained before shutdown timeout',
                context: WorkflowJobConsumer.name,
                metadata: {
                    instanceId: this.instanceId,
                    drainDurationMs,
                    drainBudgetMs: maxWaitMs,
                    drainBudgetExhausted: false,
                },
            });
        }

        // Release every PROCESSING lock held by this host. Prevents the
        // "dead worker leaves locks" pattern we traced in prod: without
        // this, orphan locks sit around until the reaper cron's 2.5h
        // timeout, blocking other workers from picking up the messages.
        try {
            const released = await this.inboxRepository.releaseAllByInstance(
                this.instanceId,
            );
            if (released > 0) {
                this.logger.log({
                    message: `Released ${released} inbox locks during shutdown`,
                    context: WorkflowJobConsumer.name,
                    metadata: {
                        instanceId: this.instanceId,
                        released,
                    },
                });
            }
        } catch (error) {
            // Never throw from a shutdown hook — best-effort by design.
            this.logger.error({
                message: 'Failed to release inbox locks during shutdown',
                context: WorkflowJobConsumer.name,
                error,
                metadata: { instanceId: this.instanceId },
            });
        }

        this.logger.log({
            message: 'Shutdown complete.',
            context: WorkflowJobConsumer.name,
        });
    }

    private isMessagePayload(
        message: any,
    ): message is MessagePayload<WorkflowJobMessage> {
        return (
            message &&
            typeof message === 'object' &&
            'event_name' in message &&
            'payload' in message
        );
    }
}
