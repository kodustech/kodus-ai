import { createLogger } from '@kodus/flow';
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
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
    SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GraphIndexerService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-indexer.service';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';

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
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly codeManagementService: CodeManagementService,
        private readonly graphIndexer: GraphIndexerService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
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

        await this.updateJobStage(jobId, 'VALIDATING');

        if (!payload?.repositoryId || !payload?.changedFiles?.length) {
            throw new Error(
                'Invalid payload: missing required fields (repositoryId, changedFiles)',
            );
        }
        // newSha is informational (logged + passed to graphIndexer for
        // tracking) but not execution-critical — the sandbox clones by
        // defaultBranch, not by sha. Keep it optional so incremental
        // updates run even when the caller can't produce a merge sha.

        let sandbox: SandboxInstance | undefined;
        let sandboxId: string | undefined;

        try {
            // Race the incremental update against the parent's AbortSignal.
            await raceWithAbortSignal((async () => {
            // 1. Resolve auth
            await this.updateJobStage(jobId, 'RESOLVING_AUTH');
            const authStart = Date.now();

            const repoRecord = await this.repositoryService.findById(
                payload.repositoryId,
            );
            if (!repoRecord) {
                throw new Error(
                    `Repository ${payload.repositoryId} not found in DB — cannot resolve clone params`,
                );
            }

            const cloneParams = await this.codeManagementService.getCloneParams(
                {
                    repository: {
                        id: repoRecord.externalId,
                        defaultBranch: repoRecord.defaultBranch,
                        fullName: repoRecord.fullName,
                        name:
                            repoRecord.fullName.split('/').pop() ||
                            repoRecord.fullName,
                    },
                    organizationAndTeamData: payload.organizationAndTeamData,
                },
                payload.platform as PlatformType,
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
            await this.updateJobStage(jobId, 'CLONING');
            const cloneStart = Date.now();

            const branchRaw = repoRecord.defaultBranch || payload.defaultBranch;
            const branch = branchRaw.replace(/^refs\/heads\//, '');

            sandbox = await this.sandboxProvider.createSandboxWithRepo({
                cloneUrl: cloneParams.url || payload.cloneUrl,
                authToken: cloneParams.auth?.token || '',
                authUsername: cloneParams.auth?.username,
                branch,
                platform: payload.platform as PlatformType,
                sandboxMetadata: { stage: 'graph-incremental' },
            });

            sandboxId =
                (sandbox as any)?.sandboxId ||
                (sandbox as any)?.id ||
                sandbox.type ||
                'unknown';

            await this.jobRepository.update(jobId, {
                metadata: { sandboxId, stage: 'CLONING' },
            });

            this.logger.log({
                message: `[AST-GRAPH-INCR] Sandbox ready for ${repoLabel} (${Date.now() - cloneStart}ms)`,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: { jobId, sandboxId },
            });

            // 3. Run incremental AST graph update
            await this.updateJobStage(jobId, 'PARSING', {
                sandboxId,
                newSha: payload.newSha,
                changedFilesCount: payload.changedFiles.length,
            });

            await this.graphIndexer.incrementalUpdate({
                repositoryId: payload.repositoryId,
                sandbox,
                changedFiles: payload.changedFiles,
                newSha: payload.newSha,
            });

            const totalMs = Date.now() - jobStart;

            await this.markCompleted(jobId, {
                repositoryId: payload.repositoryId,
                newSha: payload.newSha,
                changedFilesCount: payload.changedFiles.length,
                sandboxId,
                durationMs: totalMs,
            });

            this.logger.log({
                message: `[AST-GRAPH-INCR] Incremental update COMPLETED for ${repoLabel} in ${totalMs}ms (${payload.changedFiles.length} files)`,
                context: AstGraphIncrementalJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    newSha: payload.newSha,
                    changedFilesCount: payload.changedFiles.length,
                    sandboxId,
                    durationMs: totalMs,
                },
            });
            })(), signal);
        } catch (error) {
            const totalMs = Date.now() - jobStart;
            const classification = this.classifyError(error);

            this.logger.error({
                message: `[AST-GRAPH-INCR] Incremental update FAILED for ${repoLabel} after ${totalMs}ms — ${error.message}`,
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

            await this.handleFailure(jobId, error, classification, sandboxId, payload.repositoryId);

            if (classification === ErrorClassification.RETRYABLE) {
                throw error;
            }
        } finally {
            if (sandbox) {
                try {
                    await sandbox.cleanup();
                    this.logger.log({
                        message: `[AST-GRAPH-INCR] Sandbox cleaned up for ${repoLabel}`,
                        context: AstGraphIncrementalJobProcessor.name,
                        metadata: { jobId, sandboxId },
                    });
                } catch (cleanupError) {
                    this.logger.warn({
                        message: `[AST-GRAPH-INCR] Sandbox cleanup failed for ${repoLabel}`,
                        context: AstGraphIncrementalJobProcessor.name,
                        error: cleanupError,
                        metadata: { jobId, sandboxId },
                    });
                }
            }
        }
    }

    private async updateJobStage(
        jobId: string,
        stage: string,
        extra?: Record<string, unknown>,
    ): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.PROCESSING,
            startedAt: new Date(),
            currentStage: stage,
            metadata: { stage, ...extra },
        });
    }

    private classifyError(error: any): ErrorClassification {
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

    async handleFailure(
        jobId: string,
        error: Error,
        classification: ErrorClassification = ErrorClassification.PERMANENT,
        sandboxId?: string,
        repositoryId?: string,
    ): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: classification,
            lastError: error.message?.slice(0, 1000),
            failedAt: new Date(),
            metadata: { sandboxId, stage: 'FAILED' },
        });

        // Incremental runs when status=READY. On failure, keep it READY
        // so future incremental updates are not blocked.
        // The stale graph is still usable.
        if (repositoryId) {
            try {
                await this.repositoryService.updateGraphStatus(
                    repositoryId,
                    AstGraphStatus.READY,
                );
            } catch (statusError) {
                this.logger.warn({
                    message: `[AST-GRAPH-INCR] Failed to restore repository status to READY`,
                    context: AstGraphIncrementalJobProcessor.name,
                    error: statusError,
                    metadata: { jobId, repositoryId },
                });
            }
        }
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            currentStage: 'DONE',
            result,
        });
    }
}
