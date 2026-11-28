import { randomUUID } from 'node:crypto';
import {
    AST_GRAPH_BUILD_TIMEOUT_MS,
    GraphBaselineChangedError,
    GraphWorkerShutdownError,
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
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

// The lease manager's own default (30 min) is sized for a PR-review
// sandbox. A full-repo AST build on a large repo can legitimately run
// longer than that, and the reaper kills any lease past its expiresAt
// regardless of leaseCount — so the default would kill an actively
// building sandbox mid-index, not just a crash orphan. Give this consumer
// a ceiling well past any realistic build instead.
const GRAPH_BUILD_LEASE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

interface AstGraphBuildJobPayload {
    repositoryId: string;
    cloneUrl: string;
    defaultBranch: string;
    fullName: string;
    platform: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

@Injectable()
export class AstGraphBuildJobProcessor implements IJobProcessorService {
    private readonly logger = createLogger(AstGraphBuildJobProcessor.name);

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
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
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

        const payload = job.payload as unknown as AstGraphBuildJobPayload;
        const repoLabel =
            payload?.fullName || payload?.repositoryId || 'unknown';

        this.logger.log({
            message: `[AST-GRAPH-JOB] Starting build for ${repoLabel}`,
            context: AstGraphBuildJobProcessor.name,
            metadata: {
                jobId,
                repositoryId: payload?.repositoryId,
                fullName: payload?.fullName,
                defaultBranch: payload?.defaultBranch,
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
                AST_GRAPH_BUILD_TIMEOUT_MS,
            ))
        )
            return;

        if (
            !payload?.repositoryId ||
            !payload?.fullName ||
            !payload?.defaultBranch
        ) {
            throw new Error(
                'Invalid payload: missing required fields (repositoryId, fullName, defaultBranch)',
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
                    message: `[AST-GRAPH-JOB] Sandbox cleaned up for ${repoLabel}`,
                    context: AstGraphBuildJobProcessor.name,
                    metadata,
                });
            } catch (error) {
                this.logger.warn({
                    message: `[AST-GRAPH-JOB] Sandbox cleanup failed for ${repoLabel}`,
                    context: AstGraphBuildJobProcessor.name,
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
                message: `[AST-GRAPH-JOB] Auth resolved for ${repoLabel} (${Date.now() - authStart}ms)`,
                context: AstGraphBuildJobProcessor.name,
                metadata: {
                    jobId,
                    platform: payload.platform,
                    hasToken: !!cloneParams.auth?.token,
                    hasUsername: !!cloneParams.auth?.username,
                },
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
                        'graph-build',
                        GRAPH_BUILD_LEASE_TTL_MS,
                        {
                            cloneUrl: cloneParams.url || payload.cloneUrl,
                            authToken: cloneParams.auth?.token || '',
                            authUsername: cloneParams.auth?.username,
                            branch,
                            platform: payload.platform as PlatformType,
                            sandboxMetadata: { stage: 'graph-build' },
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
                message: `[AST-GRAPH-JOB] Sandbox ready for ${repoLabel} (${Date.now() - cloneStart}ms)`,
                context: AstGraphBuildJobProcessor.name,
                metadata: { jobId, sandboxId },
            });

            // 3. Get HEAD sha
            signal?.throwIfAborted();

            this.logger.log({
                message: `[AST-GRAPH-JOB] HEAD sha resolved: ${headSha.substring(0, 8)} for ${repoLabel}`,
                context: AstGraphBuildJobProcessor.name,
                metadata: { jobId, headSha, sandboxId },
            });

            // 4. Parse + persist
            signal?.throwIfAborted();
            await raceWithAbortSignal(
                updateGraphJobStage(this.jobRepository, attempt, 'PARSING', {
                    sandboxId,
                    headSha,
                }),
                signal,
            );

            signal?.throwIfAborted();
            const mergedDuringBuild = await raceWithAbortSignal(
                this.graphIndexer.fullBuild({
                    repositoryId: payload.repositoryId,
                    sandbox,
                    job: attempt,
                    expectedSha: repoRecord.astGraphSha ?? null,
                    headSha,
                    signal,
                }),
                signal,
            );
            signal?.throwIfAborted();

            const totalMs = Date.now() - jobStart;

            // Before completing: a failed catch-up retries the job, and the
            // deferred merge stays recorded until the catch-up is queued.
            await raceWithAbortSignal(
                this.enqueueCatchUp(
                    payload,
                    sandbox,
                    headSha,
                    mergedDuringBuild,
                    signal,
                ),
                signal,
            );
            await raceWithAbortSignal(
                this.markCompleted(
                    jobId,
                    {
                        repositoryId: payload.repositoryId,
                        headSha,
                        sandboxId,
                        durationMs: totalMs,
                    },
                    attempt.attemptId,
                ),
                signal,
            );

            this.logger.log({
                message: `[AST-GRAPH-JOB] Build COMPLETED for ${repoLabel} in ${totalMs}ms`,
                context: AstGraphBuildJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    headSha,
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
                message: `[AST-GRAPH-JOB] Build FAILED for ${repoLabel} after ${totalMs}ms`,
                error,
                context: AstGraphBuildJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
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
                payload.repositoryId,
                attempt.attemptId,
            );

            // Only re-throw TRANSIENT errors so RabbitMQ retries.
            // PERMANENT errors are already marked FAILED — retrying would just overwrite the status.
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

    /**
     * Merges that arrived while the build ran were deferred, not enqueued.
     * One incremental from the published SHA covers all of them, unless the
     * build's own checkout already contains the latest one.
     */
    async enqueueCatchUp(
        payload: AstGraphBuildJobPayload,
        sandbox: SandboxInstance,
        headSha: string,
        mergedDuringBuild: string | null | undefined,
        signal?: AbortSignal,
    ): Promise<void> {
        if (mergedDuringBuild == null) return;
        if (
            await this.containsMerge(
                sandbox,
                headSha,
                mergedDuringBuild,
                signal,
            )
        ) {
            await this.repositoryService.clearMergeDeferredDuringBuild(
                payload.repositoryId,
                mergedDuringBuild,
            );
            return;
        }
        signal?.throwIfAborted();
        await this.jobQueueService.enqueue({
            correlationId: payload.repositoryId,
            workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
            handlerType: HandlerType.SIMPLE_FUNCTION,
            payload: {
                repositoryId: payload.repositoryId,
                changedFiles: [],
                newSha: mergedDuringBuild || undefined,
                cloneUrl: '',
                defaultBranch: payload.defaultBranch,
                fullName: payload.fullName,
                platform: payload.platform,
                organizationAndTeamData: payload.organizationAndTeamData,
            },
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 3,
        });
        // Compare-and-clear: a merge deferred after this read keeps its record.
        await this.repositoryService.clearMergeDeferredDuringBuild(
            payload.repositoryId,
            mergedDuringBuild,
        );
        this.logger.log({
            message: `[AST-GRAPH-JOB] Enqueued catch-up for merges during build of ${payload.fullName}`,
            context: AstGraphBuildJobProcessor.name,
            metadata: {
                repositoryId: payload.repositoryId,
                headSha,
                mergedDuringBuild,
            },
        });
    }

    private async containsMerge(
        sandbox: SandboxInstance,
        headSha: string,
        merge: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        if (merge === headSha) return true;
        // '' means the merge SHA is unknown: only a catch-up is safe.
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(merge)) return false;
        // Exit 0 only when the merge is in the built history. A merge newer
        // than the clone is absent, so it gets the catch-up.
        const result = await sandbox.run(
            `git -C ${shSingleQuote(sandbox.repoDir)} merge-base --is-ancestor ${merge} ${shSingleQuote(headSha)}`,
            { timeoutMs: 10_000, signal },
        );
        return result.exitCode === 0;
    }

    private failureMessage(classification: ErrorClassification): string {
        return classification === ErrorClassification.RETRYABLE
            ? 'Repository graph build failed temporarily'
            : 'Repository graph build failed';
    }

    async handleFailure(
        jobId: string,
        error: Error,
        classification: ErrorClassification = classifyGraphJobError(error),
        sandboxId?: string,
        repositoryId?: string,
        attemptId?: string,
    ): Promise<void> {
        const updated = await this.jobRepository.update(
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
        if (updated === null) return;

        if (
            repositoryId &&
            attemptId &&
            !(error instanceof GraphBaselineChangedError) &&
            !(error instanceof GraphWorkerShutdownError)
        ) {
            try {
                await this.graphIndexer.failBuildForAttempt(repositoryId, {
                    jobId,
                    attemptId,
                });
            } catch (statusError) {
                if (statusError instanceof StaleGraphJobError) return;
                this.logger.warn({
                    message: `[AST-GRAPH-JOB] Failed to update repository status to FAILED`,
                    context: AstGraphBuildJobProcessor.name,
                    error: statusError,
                    metadata: { jobId, repositoryId },
                });
            }
        }
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
