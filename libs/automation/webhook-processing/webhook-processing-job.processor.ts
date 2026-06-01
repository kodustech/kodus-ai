import { createLogger } from '@kodus/flow';
import { Injectable, Inject } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    IWebhookEventHandler,
    IWebhookEventParams,
} from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';

/**
 * Processor for WEBHOOK_PROCESSING jobs
 * Processes raw webhook payloads, saves PRs, validates, and enqueues CODE_REVIEW jobs
 */
@Injectable()
export class WebhookProcessingJobProcessorService implements IJobProcessorService {
    private readonly logger = createLogger(
        WebhookProcessingJobProcessorService.name,
    );

    private readonly webhookHandlersMap: Map<
        PlatformType,
        IWebhookEventHandler
    >;

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject('GITHUB_WEBHOOK_HANDLER')
        private readonly githubPullRequestHandler: IWebhookEventHandler,
        @Inject('GITLAB_WEBHOOK_HANDLER')
        private readonly gitlabMergeRequestHandler: IWebhookEventHandler,
        @Inject('BITBUCKET_WEBHOOK_HANDLER')
        private readonly bitbucketPullRequestHandler: IWebhookEventHandler,
        @Inject('AZURE_REPOS_WEBHOOK_HANDLER')
        private readonly azureReposPullRequestHandler: IWebhookEventHandler,
        @Inject('FORGEJO_WEBHOOK_HANDLER')
        private readonly forgejoPullRequestHandler: IWebhookEventHandler,
        private readonly observability?: ObservabilityService,
    ) {
        // Initialize handlers map
        this.webhookHandlersMap = new Map<PlatformType, IWebhookEventHandler>([
            [PlatformType.GITHUB, githubPullRequestHandler],
            [PlatformType.GITLAB, gitlabMergeRequestHandler],
            [PlatformType.BITBUCKET, bitbucketPullRequestHandler],
            [PlatformType.AZURE_REPOS, azureReposPullRequestHandler],
            [PlatformType.FORGEJO, forgejoPullRequestHandler],
        ]);
    }

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);
        if (!job) {
            throw new Error(`Workflow job ${jobId} not found`);
        }

        if (signal?.aborted) {
            throw new Error(`Job ${jobId} aborted before start`);
        }

        // Validate job type
        if (job.workflowType !== WorkflowType.WEBHOOK_PROCESSING) {
            throw new Error(
                `Job ${jobId} is not a WEBHOOK_PROCESSING workflow. Got: ${job.workflowType}`,
            );
        }

        const doProcess = async (span?: any) => {
            if (span) {
                span.setAttributes({
                    'workflow.job.id': jobId,
                    'workflow.job.type': job.workflowType,
                    'workflow.correlation.id': job.correlationId,
                });
            }

            this.logger.debug({
                message: `Processing WEBHOOK_PROCESSING job ${jobId}`,
                context: WebhookProcessingJobProcessorService.name,
                metadata: {
                    jobId,
                    correlationId: job.correlationId,
                    platformType: job.metadata?.platformType,
                    event: job.metadata?.event,
                },
            });

            try {
                const platformType = job.metadata?.platformType as
                    | PlatformType
                    | undefined;
                if (!platformType) {
                    throw new Error(
                        `Job ${jobId} missing platformType in metadata`,
                    );
                }

                const event = job.metadata?.event as string | undefined;
                if (!event) {
                    throw new Error(`Job ${jobId} missing event in metadata`);
                }

                // Get handler for platform
                const handler = this.webhookHandlersMap.get(platformType);
                if (!handler) {
                    throw new Error(
                        `No handler found for platform ${platformType}`,
                    );
                }

                // Prepare webhook event params
                const webhookParams: IWebhookEventParams = {
                    payload: job.payload,
                    platformType,
                    event,
                    correlationId: job.correlationId,
                };

                // Check if handler can handle this event
                if (!handler.canHandle(webhookParams)) {
                    this.logger.warn({
                        message: `Handler cannot handle event ${event} for platform ${platformType}`,
                        context: WebhookProcessingJobProcessorService.name,
                        metadata: {
                            jobId,
                            platformType,
                            event,
                        },
                    });
                    // Mark as completed (not an error, just not handled)
                    await this.jobRepository.update(jobId, {
                        status: JobStatus.COMPLETED,
                    });
                    return;
                }
                // Race the handler against the parent's AbortSignal. When
                // the router's 9-min timeout fires, the signal aborts and
                // this line throws a JobAbortedError — the catch below
                // marks the job FAILED and releases the worker slot
                // instead of staying pinned for the full octokit
                // retry-after (which can be ~1h on an exhausted GitHub
                // App bucket). The handler promise keeps running zombie
                // in the background until octokit settles; its result is
                // discarded. See test/unit/automation/webhook-processing.
                await raceWithAbortSignal(
                    handler.execute(webhookParams),
                    signal,
                );

                await this.jobRepository.update(jobId, {
                    status: JobStatus.COMPLETED,
                });

                this.logger.log({
                    message: `WEBHOOK_PROCESSING job ${jobId} completed successfully`,
                    context: WebhookProcessingJobProcessorService.name,
                    metadata: {
                        jobId,
                        correlationId: job.correlationId,
                        platformType,
                        event,
                        result: 'Processed',
                    },
                });
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);

                this.logger.error({
                    message: `WEBHOOK_PROCESSING job ${jobId} failed`,
                    context: WebhookProcessingJobProcessorService.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: {
                        jobId,
                        correlationId: job.correlationId,
                        platformType: job.metadata?.platformType,
                        event: job.metadata?.event,
                    },
                });

                await this.jobRepository.update(jobId, {
                    status: JobStatus.FAILED,
                    errorClassification: ErrorClassification.PERMANENT,
                    lastError: errorMessage,
                });

                throw error;
            }
        };

        // Always process the job, with or without observability
        if (this.observability) {
            return await this.observability.runInSpan(
                'workflow.job.webhook.process',
                doProcess,
            );
        } else {
            return await doProcess();
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: error.message,
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
        });
    }
}
