import { Injectable, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IJobQueueService } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import type { WorkflowEphemeralPayload } from '@libs/core/workflow/domain/types/workflow-ephemeral-payload';
import { CLI_REVIEW_EPHEMERAL_ROUTING_KEY } from './workflow-queue-arguments';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { createLogger } from '@libs/core/log/logger';

import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';

@Injectable()
export class WorkflowJobQueueService implements IJobQueueService {
    private readonly logger = createLogger(WorkflowJobQueueService.name);

    constructor(
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        private readonly dataSource: DataSource,
        private readonly observability: ObservabilityService,
    ) {}

    async enqueue(
        job: Omit<IWorkflowJob, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<string> {
        return await this.observability.runInSpan(
            'workflow.job.enqueue',
            async (span) => {
                span.setAttributes({
                    'workflow.job.type': job.workflowType,
                    'workflow.job.handler': job.handlerType,
                    'workflow.correlation.id': job.correlationId,
                });

                // Transactional creation of Job and Outbox Message
                const jobToSave = await this.dataSource.transaction(
                    async (transactionManager) => {
                        const exchange = 'workflow.exchange';
                        const routingKey = `workflow.jobs.created.${job.workflowType}`;

                        const savedJob = await this.jobRepository.create(
                            job,
                            transactionManager,
                        );

                        const payload = {
                            jobId: savedJob.uuid,
                            correlationId: job.correlationId,
                            workflowType: job.workflowType,
                            handlerType: job.handlerType,
                            organizationId:
                                job.organizationAndTeamData?.organizationId,
                            teamId: job.organizationAndTeamData?.teamId,
                        };

                        const messagePayload =
                            this.messageBroker.transformMessageToMessageBroker({
                                eventName: 'workflow.jobs.created',
                                message: payload,
                            });

                        await this.outboxRepository.create(
                            {
                                jobId: savedJob.uuid,
                                exchange: exchange,
                                routingKey: routingKey,
                                payload: messagePayload as unknown as Record<
                                    string,
                                    unknown
                                >,
                            },
                            transactionManager,
                        );

                        this.logger.debug({
                            message:
                                'Workflow job and outbox message created (Transactional)',
                            context: WorkflowJobQueueService.name,
                            metadata: {
                                jobId: savedJob.uuid,
                                correlationId: job.correlationId,
                                workflowType: job.workflowType,
                            },
                        });

                        return savedJob;
                    },
                );

                span.setAttributes({
                    'workflow.job.id': jobToSave.uuid,
                });

                return jobToSave.uuid;
            },
            {
                'workflow.component': 'queue',
                'workflow.operation': 'enqueue',
            },
        );
    }

    async enqueueEphemeral(
        job: Omit<IWorkflowJob, 'id' | 'createdAt' | 'updatedAt'>,
        ephemeralPayload: WorkflowEphemeralPayload,
    ): Promise<string> {
        if (job.workflowType !== WorkflowType.CLI_CODE_REVIEW) {
            throw new Error(
                `Ephemeral transport is not configured for ${job.workflowType}`,
            );
        }

        return this.observability.runInSpan(
            'workflow.job.enqueue_ephemeral',
            async (span) => {
                const savedJob = await this.dataSource.transaction(
                    async (transactionManager) =>
                        this.jobRepository.create(job, transactionManager),
                );
                const exchange = 'workflow.exchange';
                const routingKey = CLI_REVIEW_EPHEMERAL_ROUTING_KEY;
                const messagePayload =
                    this.messageBroker.transformMessageToMessageBroker({
                        eventName: 'workflow.jobs.ephemeral',
                        message: {
                            jobId: savedJob.uuid,
                            correlationId: job.correlationId,
                            workflowType: job.workflowType,
                            handlerType: job.handlerType,
                            organizationId:
                                job.organizationAndTeamData?.organizationId,
                            teamId: job.organizationAndTeamData?.teamId,
                            ephemeralPayload,
                        },
                    });

                span.setAttributes({
                    'workflow.job.id': savedJob.uuid,
                    'workflow.job.type': job.workflowType,
                    'workflow.job.handler': job.handlerType,
                    'workflow.correlation.id': job.correlationId,
                    'workflow.job.ephemeral': true,
                });

                try {
                    await this.messageBroker.publishMessage(
                        { exchange, routingKey },
                        messagePayload,
                        {
                            persistent: false,
                            expiration: 35 * 60 * 1000,
                            messageId: messagePayload.messageId,
                            correlationId: job.correlationId,
                            headers: { 'x-kodus-ephemeral': true },
                        },
                    );
                } catch (error) {
                    await this.jobRepository.update(savedJob.uuid, {
                        status: JobStatus.FAILED,
                    });
                    throw error;
                }

                this.logger.debug({
                    message:
                        'Workflow job created with ephemeral broker payload',
                    context: WorkflowJobQueueService.name,
                    metadata: {
                        jobId: savedJob.uuid,
                        correlationId: job.correlationId,
                        workflowType: job.workflowType,
                    },
                });

                return savedJob.uuid;
            },
            {
                'workflow.component': 'queue',
                'workflow.operation': 'enqueue_ephemeral',
            },
        );
    }

    async getStatus(jobId: string): Promise<IWorkflowJob | null> {
        return await this.jobRepository.findOne(jobId);
    }

    async listJobs(filters: {
        status?: any;
        workflowType?: any;
        organizationId?: string;
        teamId?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        data: IWorkflowJob[];
        total: number;
        limit: number;
        offset: number;
    }> {
        const result = await this.jobRepository.findMany({
            status: filters.status,
            workflowType: filters.workflowType,
            organizationId: filters.organizationId,
            teamId: filters.teamId,
            limit: filters.limit,
            offset: filters.offset,
        });

        return {
            data: result.data,
            total: result.total,
            limit: filters.limit || 50,
            offset: filters.offset || 0,
        };
    }
}
