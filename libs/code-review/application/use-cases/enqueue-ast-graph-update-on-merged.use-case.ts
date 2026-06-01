import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export interface EnqueueAstGraphUpdateInput {
    prNumber: number;
    repoExternalId: string;
    repoName: string;
    platform: PlatformType;
    baseBranch: string;
    /**
     * SHA representing the new state of the default branch after the merge.
     * Used for tracking/auditing the graph version; the incremental
     * processor tolerates missing values.
     */
    newSha?: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

export type EnqueueAstGraphUpdateResult =
    | { enqueued: false; reason: string }
    | {
          enqueued: true;
          jobType: 'incremental' | 'full-rebuild';
          jobId: string;
          filesCount: number;
      };

/**
 * Triggered when a PR is merged into the default branch.
 *
 * Fetches the PR's changed files via the platform API (same
 * getFilesByPullRequestId used by the code review pipeline), then
 * enqueues an AST graph update job to keep the persisted baseline
 * in sync.
 *
 * Strategy:
 *   - Skip if repo has no graph yet (astGraphStatus !== READY)
 *   - Skip if baseBranch !== repo.defaultBranch
 *   - > 500 files → full rebuild
 *   - Otherwise → incremental update
 */
@Injectable()
export class EnqueueAstGraphUpdateOnMergedUseCase implements IUseCase {
    private readonly logger = createLogger(
        EnqueueAstGraphUpdateOnMergedUseCase.name,
    );

    private static readonly MAX_INCREMENTAL_FILES = 500;

    constructor(
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async execute(
        input: EnqueueAstGraphUpdateInput,
    ): Promise<EnqueueAstGraphUpdateResult> {
        const {
            prNumber,
            repoExternalId,
            repoName,
            platform,
            baseBranch,
            newSha,
            organizationAndTeamData,
        } = input;

        let repo;
        try {
            repo = await this.repositoryService.findByExternalId(
                platform,
                repoExternalId,
            );
        } catch (error) {
            this.logger.warn({
                message: `[AST-GRAPH] Failed to lookup repository for merged PR#${prNumber}`,
                context: EnqueueAstGraphUpdateOnMergedUseCase.name,
                error,
                metadata: { repoExternalId, platform, prNumber },
            });
            return { enqueued: false, reason: 'repo lookup failed' };
        }

        if (!repo) {
            return { enqueued: false, reason: 'repo not tracked' };
        }

        if (baseBranch !== repo.defaultBranch) {
            return {
                enqueued: false,
                reason: `base branch ${baseBranch} is not default (${repo.defaultBranch})`,
            };
        }

        if (repo.astGraphStatus !== AstGraphStatus.READY) {
            return {
                enqueued: false,
                reason: `graph not ready (${repo.astGraphStatus})`,
            };
        }

        let changedFiles: string[];
        try {
            const files =
                (await this.codeManagementService.getFilesByPullRequestId(
                    {
                        organizationAndTeamData,
                        repository: { id: repoExternalId, name: repoName },
                        prNumber,
                    },
                    platform as any,
                )) ?? [];

            changedFiles = files
                .map((f: any) => f.filename as string)
                .filter(Boolean);
        } catch (error) {
            this.logger.warn({
                message: `[AST-GRAPH] Failed to fetch PR files for PR#${prNumber}`,
                context: EnqueueAstGraphUpdateOnMergedUseCase.name,
                error,
                metadata: { repoExternalId, platform, prNumber },
            });
            return { enqueued: false, reason: 'failed to fetch PR files' };
        }

        if (changedFiles.length === 0) {
            return { enqueued: false, reason: 'no changed files' };
        }

        const useFullRebuild =
            changedFiles.length >
            EnqueueAstGraphUpdateOnMergedUseCase.MAX_INCREMENTAL_FILES;

        try {
            const jobId = useFullRebuild
                ? await this.jobQueueService.enqueue({
                      correlationId: repo.uuid,
                      workflowType: WorkflowType.AST_GRAPH_BUILD,
                      handlerType: HandlerType.SIMPLE_FUNCTION,
                      payload: {
                          repositoryId: repo.uuid,
                          cloneUrl: '',
                          defaultBranch: repo.defaultBranch,
                          fullName: repo.fullName,
                          platform: repo.platform,
                          organizationAndTeamData,
                      },
                      status: JobStatus.PENDING,
                      priority: 0,
                      retryCount: 0,
                      maxRetries: 3,
                  })
                : await this.jobQueueService.enqueue({
                      correlationId: repo.uuid,
                      workflowType: WorkflowType.AST_GRAPH_INCREMENTAL,
                      handlerType: HandlerType.SIMPLE_FUNCTION,
                      payload: {
                          repositoryId: repo.uuid,
                          changedFiles,
                          newSha,
                          cloneUrl: '',
                          defaultBranch: repo.defaultBranch,
                          fullName: repo.fullName,
                          platform: repo.platform,
                          organizationAndTeamData,
                      },
                      status: JobStatus.PENDING,
                      priority: 0,
                      retryCount: 0,
                      maxRetries: 3,
                  });

            this.logger.log({
                message: `[AST-GRAPH] Enqueued ${useFullRebuild ? 'full rebuild' : 'incremental update'} for ${repo.fullName} after PR#${prNumber} merge: ${changedFiles.length} files`,
                context: EnqueueAstGraphUpdateOnMergedUseCase.name,
                metadata: {
                    repoExternalId,
                    platform,
                    prNumber,
                    fullName: repo.fullName,
                    jobType: useFullRebuild ? 'full-rebuild' : 'incremental',
                    filesCount: changedFiles.length,
                    jobId,
                },
            });

            return {
                enqueued: true,
                jobType: useFullRebuild ? 'full-rebuild' : 'incremental',
                jobId,
                filesCount: changedFiles.length,
            };
        } catch (error) {
            this.logger.warn({
                message: `[AST-GRAPH] Failed to enqueue graph update for ${repo.fullName} after PR#${prNumber} merge`,
                context: EnqueueAstGraphUpdateOnMergedUseCase.name,
                error,
                metadata: { repoExternalId, platform, prNumber },
            });
            return { enqueued: false, reason: 'enqueue failed' };
        }
    }
}
