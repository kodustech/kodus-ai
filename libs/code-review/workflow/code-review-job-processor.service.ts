import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject, Optional } from '@nestjs/common';

import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    WORKFLOW_JOB_REPOSITORY_TOKEN,
    IWorkflowJobRepository,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { EnqueueCodeReviewJobInput } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationRecipient } from '@libs/notifications/domain/recipient';
import { ByokConcurrencyGateService } from './byok-concurrency-gate.service';
import { DistributedLock } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import {
    IRateLimitGateService,
    RATE_LIMIT_GATE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/rate-limit-gate.service.contract';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';

@Injectable()
export class CodeReviewJobProcessorService implements IJobProcessorService {
    private readonly logger = createLogger(CodeReviewJobProcessorService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly runCodeReviewAutomationUseCase: RunCodeReviewAutomationUseCase,
        private readonly byokConcurrencyGateService: ByokConcurrencyGateService,
        private readonly notificationService: NotificationService,
        private readonly prAuthorRecipientResolver: PrAuthorRecipientResolver,
        @Inject(RATE_LIMIT_GATE_SERVICE_TOKEN)
        private readonly rateLimitGate: IRateLimitGateService,
        @Optional()
        private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const correlationId = job.correlationId;

        this.logger.log({
            message: `Processing Code Review Job ${jobId}`,
            context: CodeReviewJobProcessorService.name,
            metadata: { jobId, correlationId },
        });

        if (signal?.aborted) {
            throw new Error(`Job ${jobId} aborted before start`);
        }

        const startTime = Date.now();
        let acquiredLock: DistributedLock | null = null;

        try {
            const jobPayload = job.payload || {};
            const {
                codeManagementPayload,
                event,
                platformType,
                organizationAndTeamData,
                teamAutomationId,
            } = jobPayload as EnqueueCodeReviewJobInput;

            if (
                !codeManagementPayload ||
                !event ||
                !platformType ||
                !organizationAndTeamData ||
                !teamAutomationId
            ) {
                throw new Error('Invalid payload: missing required fields');
            }

            // Short-circuit when the installation's GitHub bucket is
            // already below the safety threshold. The gate throws
            // RateLimitError(resetAt), and the consumer error handler
            // republishes with a delay aligned to the bucket reset
            // (instead of burning the full router timeout watching
            // octokit sleep retry-after). Cheap call: /rate_limit does
            // not consume quota.
            await this.rateLimitGate.check(
                organizationAndTeamData,
                platformType,
            );

            const admission =
                await this.byokConcurrencyGateService.tryEnter(job);

            if (admission.kind === 'deferred') {
                await this.byokConcurrencyGateService.deferJob(job, admission);
                return;
            }

            if (admission.kind === 'acquired') {
                acquiredLock = admission.lock;
            }

            await this.jobRepository.update(jobId, {
                status: JobStatus.PROCESSING,
                startedAt: new Date(),
                metadata: this.removeByokConcurrencyGateMetadata(job.metadata),
            });

            // Race the use-case against the parent's AbortSignal. The use
            // case already receives `signal` (PR #1 wired it down to the
            // LLM agent loop), but any link of the chain that does NOT
            // honor it — an octokit sleep, a downstream service stuck on
            // retry-after, a synchronous CPU section — keeps the promise
            // pending past the 1h45min router timeout, holding the worker
            // slot zombie. The race guarantees the processor unblocks
            // when the signal fires regardless of how deep the stall is.
            await raceWithAbortSignal(
                this.runCodeReviewAutomationUseCase.execute(
                    {
                        codeManagementPayload,
                        event,
                        platformType,
                        correlationId,
                        organizationAndTeamData,
                        teamAutomationId,
                        workflowJobId: jobId,
                    },
                    signal,
                ),
                signal,
            );

            await this.markCompleted(jobId);

            const durationMs = Date.now() - startTime;
            this.metricsCollector?.recordHistogram(
                'code_review_duration_ms',
                durationMs,
                { status: 'success' },
            );
        } catch (rawError) {
            // Wrap octokit 403/429 in RateLimitError so the consumer
            // error handler can apply the smart delay. If the error
            // wasn't a GitHub rate-limit, classifyGitHubError returns
            // it unchanged. We also defer-re-throw the classified
            // version so the consumer (RabbitMQErrorHandler) sees the
            // typed error, not the raw octokit shape.
            const error = classifyGitHubError(rawError) as Error;

            if (error.name === 'WorkflowPausedError') {
                await this.jobRepository.update(jobId, {
                    status: JobStatus.WAITING_FOR_EVENT,
                    waitingForEvent: {
                        eventType: (error as any).eventType,
                        eventKey: (error as any).eventKey,
                    },
                });
                return;
            }

            this.logger.error({
                message: `Job ${jobId} failed`,
                error,
                context: CodeReviewJobProcessorService.name,
            });

            await this.handleFailure(jobId, error);
            // Don't spam the author with a failure notification when we
            // know the job is going to retry on its own (rate-limit will
            // resolve when the GitHub bucket resets). They'd get one
            // email per retry otherwise.
            if (!isRateLimitError(error)) {
                await this.notifyReviewFailed(job, error, correlationId);
            }
            throw error;
        } finally {
            if (acquiredLock && !acquiredLock.isReleased()) {
                try {
                    await acquiredLock.release();
                    this.logger.log({
                        message: `[BYOK-CONCURRENCY-GATE] released slot for job ${jobId}`,
                        context: CodeReviewJobProcessorService.name,
                        metadata: { jobId, correlationId },
                    });
                } catch (releaseError) {
                    this.logger.error({
                        message:
                            'Failed to release distributed BYOK concurrency slot',
                        error: releaseError,
                        context: CodeReviewJobProcessorService.name,
                        metadata: { jobId, correlationId },
                    });
                }
            }
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        this.metricsCollector?.recordCounter('code_review_errors_total', 1, {
            errorType: error.name || 'UnknownError',
        });

        // Surface RATE_LIMITED in the job row so the dashboard / DB
        // queries can distinguish "stuck on GitHub quota, will retry"
        // from a genuine permanent failure. The consumer error handler
        // computes the smart delay from the error object itself; this
        // classification on the job row is purely informational.
        const classification = isRateLimitError(error)
            ? ErrorClassification.RATE_LIMITED
            : ErrorClassification.PERMANENT;

        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: classification,
            lastError: error.message,
            failedAt: new Date(),
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            result: result,
        });
    }

    private removeByokConcurrencyGateMetadata(
        metadata?: Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        if (!metadata?.byokConcurrencyGate) {
            return metadata;
        }

        const nextMetadata = { ...metadata };
        delete nextMetadata.byokConcurrencyGate;

        return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
    }

    /**
     * Best-effort notification for a terminally-failed code review.
     * Targets the PR author (when extractable from the platform webhook
     * payload and resolvable to an internal user) plus all org owners.
     *
     * Failures here never re-throw — the surrounding catch block already
     * marked the job FAILED and is about to rethrow the original error.
     */
    private async notifyReviewFailed(
        job: { payload?: unknown },
        error: Error,
        correlationId: string,
    ): Promise<void> {
        try {
            const jobPayload = (job?.payload ?? {}) as Partial<
                EnqueueCodeReviewJobInput
            > & { codeManagementPayload?: any };
            const organizationId =
                jobPayload.organizationAndTeamData?.organizationId;
            if (!organizationId) return;

            // Platform webhook payloads vary by provider — defensive
            // extraction tries the most common shapes (GitHub
            // `pull_request`, GitLab `object_attributes`/`merge_request`,
            // Bitbucket `pullrequest`). Missing fields fall back to
            // empty strings; the notification still goes out to owners.
            const cm = jobPayload.codeManagementPayload ?? {};
            const pr =
                cm.pull_request ??
                cm.pullrequest ??
                cm.object_attributes ??
                cm.merge_request ??
                {};
            const repo = cm.repository ?? pr.repository ?? {};

            const prUrl: string =
                pr.html_url ?? pr.web_url ?? pr.url ?? '';
            const repoName: string =
                repo.full_name ?? repo.name ?? cm.repository?.full_name ?? '';
            const author =
                pr.user ?? pr.author ?? cm.actor ?? cm.sender ?? {};
            const authorEmail: string | undefined =
                author?.email ?? author?.emailAddress;
            const authorLogin: string | undefined =
                author?.login ?? author?.username ?? author?.nickname;

            // Owners are the config-driven audience (defaultRoles in the
            // catalog); only the PR author is passed as a directed recipient.
            const recipients: NotificationRecipient[] = [];
            if (authorEmail) {
                const prAuthor =
                    await this.prAuthorRecipientResolver.resolve(
                        { email: authorEmail, login: authorLogin },
                        organizationId,
                    );
                if (prAuthor) recipients.push(prAuthor);
            }

            const isAIEmptyBodyError =
                error?.message?.includes('Last error: <none>');

            const reason = isAIEmptyBodyError
                ? `The configured AI provider returned empty responses for several requests in a row. This is usually a transient provider issue. You can re-run the review or switch to a different model in Settings → AI Provider. (${error?.message || ''})`
                : error?.message ?? 'unknown error';

            await this.notificationService.emit({
                event: NotificationEvent.REVIEW_FAILED,
                payload: {
                    prUrl,
                    repoName,
                    reason,
                    correlationId,
                },
                organizationId,
                recipients,
                correlationId,
            });
        } catch (emitError) {
            this.logger.error({
                message: 'Failed to emit review.failed notification',
                error:
                    emitError instanceof Error
                        ? emitError
                        : new Error(String(emitError)),
                context: CodeReviewJobProcessorService.name,
            });
        }
    }
}
