import { randomUUID } from 'node:crypto';
import {
    AST_GRAPH_BUILD_TIMEOUT_MS,
    GraphBaselineChangedError,
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
import { RecordedJobFailure } from '@libs/core/workflow/domain/errors/recorded-job-failure.error';
import { claimGraphJob, updateGraphJobStage } from './graph-job-stage';
import { GraphJobSandbox, graphCheckoutSha } from './graph-job-sandbox';

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
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const jobStart = Date.now();
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        if (signal?.aborted) {
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

        const attempt: GraphJobAttempt = { jobId, attemptId: randomUUID() };
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

            lease = await this.graphSandbox.acquire(
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
            );
            const { sandbox } = lease;
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
            const headSha = await graphCheckoutSha(
                sandbox,
                lease.wasCreated,
                repoRecord.astGraphSha,
                signal,
            );

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
            await raceWithAbortSignal(
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
        } catch (error) {
            if (error instanceof StaleGraphJobError) return;
            const totalMs = Date.now() - jobStart;
            const classification = this.classifyError(error);

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
            if (error instanceof GraphBaselineChangedError) throw error;
            if (classification === ErrorClassification.RETRYABLE) {
                throw new RecordedJobFailure(
                    this.failureMessage(classification),
                );
            }
        } finally {
            if (lease) await releaseSandbox(lease);
        }
    }

    private classifyError(error: any): ErrorClassification {
        if (error instanceof GraphBaselineChangedError)
            return ErrorClassification.RETRYABLE;
        const msg = (error?.message || '').toLowerCase();
        const stderr = (error?.result?.stderr || '').toLowerCase();
        const combined = `${msg} ${stderr}`;

        // Transient: sandbox, network, timeout, clone auth, resource exhaustion
        if (
            combined.includes('timeout') ||
            combined.includes('econnrefused') ||
            combined.includes('econnreset') ||
            combined.includes('enotfound') ||
            combined.includes('epipe') ||
            combined.includes('sandbox') ||
            combined.includes('exit status 128') ||
            combined.includes('could not resolve host') ||
            combined.includes('rate limit') ||
            combined.includes('out of memory') ||
            combined.includes('enomem') ||
            combined.includes('enospc') ||
            combined.includes('503') ||
            combined.includes('502') ||
            combined.includes('temporarily unavailable')
        ) {
            return ErrorClassification.RETRYABLE;
        }

        return ErrorClassification.PERMANENT;
    }

    private failureMessage(classification: ErrorClassification): string {
        return classification === ErrorClassification.RETRYABLE
            ? 'Repository graph build failed temporarily'
            : 'Repository graph build failed';
    }

    async handleFailure(
        jobId: string,
        error: Error,
        classification: ErrorClassification = this.classifyError(error),
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
                failedAt: new Date(),
                metadata: { attemptId, sandboxId, stage: 'FAILED' },
            },
            [JobStatus.PROCESSING, JobStatus.FAILED],
            attemptId,
        );
        if (updated === null) return;

        if (
            repositoryId &&
            attemptId &&
            !(error instanceof GraphBaselineChangedError)
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
