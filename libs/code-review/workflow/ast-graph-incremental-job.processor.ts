import { randomUUID } from 'node:crypto';
import {
    AST_GRAPH_INCREMENTAL_TIMEOUT_MS,
    GraphBaselineChangedError,
    GraphWorkerShutdownError,
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { PlatformType } from '@libs/core/domain/enums';
import {
    AcquireResult,
    ISandboxLeaseManager,
    SANDBOX_LEASE_MANAGER_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GraphIndexerService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-indexer.service';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { WorkflowJobTimeoutError } from '@libs/core/workflow/infrastructure/run-with-timeout';
import { RecordedJobFailure } from '@libs/core/workflow/domain/errors/recorded-job-failure.error';
import { classifyGraphJobError } from './graph-job-failure';
import { claimGraphJob, updateGraphJobStage } from './graph-job-stage';
import { GraphJobSandbox } from './graph-job-sandbox';
import { graphCheckoutFiles } from './graph-checkout';

// The lease manager's own default (30 min) is sized for a PR-review
// sandbox. An incremental AST update on a large changeset can legitimately
// run longer than that, and the reaper kills any lease past its expiresAt
// regardless of leaseCount — so the default would kill an actively
// updating sandbox mid-index, not just a crash orphan. Give this consumer
// a ceiling well past any realistic update instead.
const GRAPH_INCREMENTAL_LEASE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

interface AstGraphIncrementalJobPayload {
    repositoryId: string;
    changedFiles: string[];
    newSha: string;
    cloneUrl: string;
    defaultBranch: string;
    fullName: string;
    platform: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

@Injectable()
export class AstGraphIncrementalJobProcessor implements IJobProcessorService {
    private readonly logger = createLogger(
        AstGraphIncrementalJobProcessor.name,
    );

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(SANDBOX_LEASE_MANAGER_TOKEN)
        private readonly leaseManager: ISandboxLeaseManager,
        private readonly codeManagementService: CodeManagementService,
        private readonly graphIndexer: GraphIndexerService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        private readonly graphSandbox: GraphJobSandbox,
    ) {}

    async process(
        jobId: string,
        signal?: AbortSignal,
        attemptId: string = randomUUID(),
    ): Promise<void> {
        const jobStart = Date.now();
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        if (signal?.aborted) {
            if (signal.reason instanceof GraphWorkerShutdownError)
                throw signal.reason;
            throw new Error(`Job ${jobId} aborted before start`);
        }

        const payload = job.payload as unknown as AstGraphIncrementalJobPayload;
        const repoLabel =
            payload?.fullName || payload?.repositoryId || 'unknown';

        this.logger.log({
            message: `[AST-GRAPH-INCR] Starting incremental update for ${repoLabel}`,
            context: AstGraphIncrementalJobProcessor.name,
            metadata: {
                jobId,
                repositoryId: payload?.repositoryId,
                fullName: payload?.fullName,
                newSha: payload?.newSha,
                changedFilesCount: payload?.changedFiles?.length,
                platform: payload?.platform,
                correlationId: job.correlationId,
            },
        });

        const attempt: GraphJobAttempt = { jobId, attemptId };
        if (
            !(await claimGraphJob(
                this.jobRepository,
                job,
                attempt,
                AST_GRAPH_INCREMENTAL_TIMEOUT_MS,
            ))
        )
            return;

        if (!payload?.repositoryId || !payload?.changedFiles?.length) {
            throw new Error(
                'Invalid payload: missing required fields (repositoryId, changedFiles)',
            );
        }
        const prKey = `${payload.organizationAndTeamData?.organizationId}:${payload.repositoryId}:graph:${jobId}`;
        let lease: AcquireResult | undefined;
        let sandboxId: string | undefined;
        const releaseSandbox = async ({
            leaseId,
            sandboxId,
        }: AcquireResult) => {
            const metadata = {
                jobId,
                prKey,
                sandboxId,
                organizationId: payload.organizationAndTeamData?.organizationId,
            };
            try {
                await this.leaseManager.release(leaseId, { idleMs: 0 });
                this.logger.log({
                    message: `[AST-GRAPH-INCR] Sandbox cleaned up for ${repoLabel}`,
                    context: AstGraphIncrementalJobProcessor.name,
                    metadata,
                });
            } catch (error) {
                this.logger.warn({
                    message: `[AST-GRAPH-INCR] Sandbox cleanup failed for ${repoLabel}`,
                    context: AstGraphIncrementalJobProcessor.name,
                    error,
                    metadata,
                });
            }
        };

        try {
            signal?.throwIfAborted();
            // 1. Resolve auth
            await raceWithAbortSignal(
                updateGraphJobStage(
                    this.jobRepository,
                    attempt,
                    'RESOLVING_AUTH',
                ),
                signal,
            );
            const authStart = Date.now();

            signal?.throwIfAborted();
            const repoRecord = await raceWithAbortSignal(
                this.repositoryService.findById(payload.repositoryId),
                signal,
            );
            if (!repoRecord) {
                throw new Error(
                    `Repository ${payload.repositoryId} not found in DB — cannot resolve clone params`,
                );
            }

            signal?.throwIfAborted();
            const cloneParams = await raceWithAbortSignal(
                this.codeManagementService.getCloneParams(
                    {
                        repository: {
                            id: repoRecord.externalId,
                            defaultBranch: repoRecord.defaultBranch,
                            fullName: repoRecord.fullName,
                            name:
                                repoRecord.fullName.split('/').pop() ||
                                repoRecord.fullName,
                        },
                        organizationAndTeamData:
                            payload.organizationAndTeamData,
                    },
                    payload.platform as PlatformType,
                ),
                signal,
            );

            if (!cloneParams) {
                throw new Error(
                    `Failed to resolve clone params for ${repoRecord.fullName} (platform=${payload.platform}) — provider returned null`,
                );
            }

            this.logger.log({
                message: `[AST-GRAPH-INCR] Auth resolved for ${repoLabel} (${Date.now() - authStart}ms)`,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: { jobId, hasToken: !!cloneParams.auth?.token },
            });

            // 2. Create sandbox + clone
            signal?.throwIfAborted();
            await raceWithAbortSignal(
                updateGraphJobStage(this.jobRepository, attempt, 'CLONING'),
                signal,
            );
            const cloneStart = Date.now();

            const branchRaw = repoRecord.defaultBranch || payload.defaultBranch;
            const branch = branchRaw.replace(/^refs\/heads\//, '');

            const checkout = await this.graphSandbox.acquireCheckout(
                () =>
                    this.leaseManager.acquire(
                        prKey,
                        'graph-incremental',
                        GRAPH_INCREMENTAL_LEASE_TTL_MS,
                        {
                            cloneUrl: cloneParams.url || payload.cloneUrl,
                            authToken: cloneParams.auth?.token || '',
                            authUsername: cloneParams.auth?.username,
                            branch,
                            includeParentCommit: true,
                            platform: payload.platform as PlatformType,
                            sandboxMetadata: { stage: 'graph-incremental' },
                            organizationId:
                                payload.organizationAndTeamData?.organizationId,
                            teamId: payload.organizationAndTeamData?.teamId,
                        },
                        { signal },
                    ),
                signal,
                releaseSandbox,
                repoRecord.astGraphSha,
                (id) => this.leaseManager.retireSingleUseCheckout(prKey, id),
            );
            lease = checkout;
            const { sandbox, headSha } = checkout;
            sandboxId = lease.sandboxId;

            signal?.throwIfAborted();
            await raceWithAbortSignal(
                this.jobRepository.update(
                    jobId,
                    {
                        metadata: {
                            attemptId: attempt.attemptId,
                            sandboxId,
                            stage: 'CLONING',
                        },
                    },
                    JobStatus.PROCESSING,
                    attempt.attemptId,
                ),
                signal,
            );

            this.logger.log({
                message: `[AST-GRAPH-INCR] Sandbox ready for ${repoLabel} (${Date.now() - cloneStart}ms)`,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: { jobId, sandboxId },
            });

            const changedFiles = await graphCheckoutFiles(
                sandbox,
                repoRecord.astGraphSha,
                headSha,
                signal,
            );
            const fileCount = changedFiles?.length;
            // 3. Run incremental AST graph update
            signal?.throwIfAborted();
            await raceWithAbortSignal(
                updateGraphJobStage(this.jobRepository, attempt, 'PARSING', {
                    sandboxId,
                    newSha: headSha,
                    changedFilesCount: fileCount,
                }),
                signal,
            );

            signal?.throwIfAborted();
            await raceWithAbortSignal(
                this.graphIndexer.incrementalUpdate({
                    repositoryId: payload.repositoryId,
                    sandbox,
                    job: attempt,
                    expectedSha: repoRecord.astGraphSha ?? null,
                    changedFiles,
                    newSha: headSha,
                    signal,
                }),
                signal,
            );
            signal?.throwIfAborted();

            const totalMs = Date.now() - jobStart;

            await raceWithAbortSignal(
                this.markCompleted(
                    jobId,
                    {
                        repositoryId: payload.repositoryId,
                        newSha: headSha,
                        changedFilesCount: fileCount,
                        sandboxId,
                        durationMs: totalMs,
                    },
                    attempt.attemptId,
                ),
                signal,
            );

            this.logger.log({
                message: `[AST-GRAPH-INCR] Incremental update COMPLETED for ${repoLabel} in ${totalMs}ms (${fileCount ?? 'all'} files)`,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    newSha: headSha,
                    changedFilesCount: fileCount,
                    sandboxId,
                    durationMs: totalMs,
                },
            });
        } catch (caught) {
            if (caught instanceof StaleGraphJobError) return;
            const reason = signal?.reason;
            const error =
                reason instanceof GraphWorkerShutdownError ||
                reason instanceof WorkflowJobTimeoutError
                    ? reason
                    : caught;
            const totalMs = Date.now() - jobStart;
            const classification = classifyGraphJobError(error);

            this.logger.error({
                message: `[AST-GRAPH-INCR] Incremental update FAILED for ${repoLabel} after ${totalMs}ms`,
                error,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    newSha: payload.newSha,
                    changedFilesCount: payload.changedFiles?.length,
                    sandboxId,
                    durationMs: totalMs,
                    classification,
                },
            });

            await this.handleFailure(
                jobId,
                error,
                classification,
                sandboxId,
                attempt.attemptId,
            );

            if (
                error instanceof GraphBaselineChangedError ||
                error instanceof GraphWorkerShutdownError
            )
                throw error;
            if (classification === ErrorClassification.RETRYABLE) {
                throw new RecordedJobFailure(
                    this.failureMessage(classification),
                );
            }
        } finally {
            if (lease) await releaseSandbox(lease);
        }
    }

    private failureMessage(classification: ErrorClassification): string {
        return classification === ErrorClassification.RETRYABLE
            ? 'Repository graph incremental update failed temporarily'
            : 'Repository graph incremental update failed';
    }

    async handleFailure(
        jobId: string,
        error: Error,
        classification: ErrorClassification = classifyGraphJobError(error),
        sandboxId?: string,
        attemptId?: string,
    ): Promise<void> {
        await this.jobRepository.update(
            jobId,
            {
                status: JobStatus.FAILED,
                errorClassification: classification,
                lastError: this.failureMessage(classification),
                completedAt: new Date(),
                currentStage: 'FAILED',
                metadata: { attemptId, sandboxId, stage: 'FAILED' },
            },
            [JobStatus.PROCESSING, JobStatus.FAILED],
            attemptId,
        );
        // The incremental transaction preserves the previous revision on failure.
    }

    async markCompleted(
        jobId: string,
        result?: unknown,
        attemptId?: string,
    ): Promise<void> {
        const updated = await this.jobRepository.update(
            jobId,
            {
                status: JobStatus.COMPLETED,
                completedAt: new Date(),
                currentStage: 'DONE',
                result,
            },
            JobStatus.PROCESSING,
            attemptId,
        );
        if (updated === null) throw new StaleGraphJobError(jobId);
    }
}
