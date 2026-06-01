import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repository as RepositoryConfig } from '@libs/integrations/domain/integrationConfigs/types/codeManagement/repositories.type';

export interface BackfillAstGraphBuildInput {
    organizationId: string;
    teamId: string;
    force?: boolean;
    limit?: number;
}

export interface BackfillAstGraphBuildOutput {
    matched: number;
    skipped: Array<{ fullName: string; reason: string }>;
    enqueued: number;
    jobIds: string[];
    errors: Array<{ repositoryId: string; error: string }>;
}

/**
 * Source of truth for "which repos belong to a team" is
 * integration_configs (REPOSITORIES key), not the `repositories` table —
 * the former is what the client selected for review, the latter only gets
 * populated when the AST graph flow runs. Legacy customers may have many
 * selected repos in integration_configs with no corresponding row in
 * `repositories` yet.
 *
 * For each configured+selected repo, the use-case:
 *   1. findOrCreate the row in `repositories` (so it is tracked and
 *      receives PENDING status if brand new)
 *   2. Decides whether to enqueue an AST_GRAPH_BUILD job based on the
 *      current astGraphStatus.
 *
 * Status policy:
 *   - NULL / PENDING / FAILED → enqueue (same as CreateRepositoriesUseCase)
 *   - READY                   → enqueue only when `force = true`
 *   - BUILDING                → never re-enqueue (job already in flight)
 */
@Injectable()
export class BackfillAstGraphBuildUseCase implements IUseCase {
    private readonly logger = createLogger(BackfillAstGraphBuildUseCase.name);

    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
    ) {}

    async execute(
        input: BackfillAstGraphBuildInput,
    ): Promise<BackfillAstGraphBuildOutput> {
        const { organizationId, teamId, force = false, limit = 10 } = input;

        const repositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                RepositoryConfig[]
            >(IntegrationConfigKey.REPOSITORIES, {
                organizationId,
                teamId,
            })) || [];

        // Also fetch the integration to resolve the platform (REPOSITORIES
        // configValue doesn't carry it, but it's required for findOrCreate
        // and for the job payload).
        const cfgWithIntegration =
            await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.REPOSITORIES,
                { organizationId, teamId },
            );
        const platform = cfgWithIntegration?.integration?.platform;

        this.logger.log({
            message: `[AST-BACKFILL] org=${organizationId} team=${teamId} platform=${platform} found ${repositories.length} configured repos force=${force} limit=${limit}`,
            context: BackfillAstGraphBuildUseCase.name,
        });

        if (!platform) {
            throw new Error(
                `No integration/platform found for org=${organizationId} team=${teamId}`,
            );
        }

        const selected = repositories.filter(
            (r) => r?.id && r.selected !== false,
        );

        const skipped: Array<{ fullName: string; reason: string }> = [];
        const jobIds: string[] = [];
        const errors: Array<{ repositoryId: string; error: string }> = [];

        for (const repo of selected) {
            if (jobIds.length >= limit) break;

            const fullName =
                (repo as any).full_name ||
                (repo as any).fullName ||
                repo.name ||
                String(repo.id);

            try {
                const repoRecord = await this.repositoryService.findOrCreate({
                    integrationConfigId: teamId,
                    externalId: String(repo.id),
                    name: repo.name,
                    fullName,
                    platform,
                    defaultBranch: (repo as any).default_branch,
                });

                const status = repoRecord.astGraphStatus;

                if (status === AstGraphStatus.BUILDING) {
                    skipped.push({
                        fullName,
                        reason: 'BUILDING (job already in flight)',
                    });
                    continue;
                }
                if (status === AstGraphStatus.READY && !force) {
                    skipped.push({
                        fullName,
                        reason: 'READY (use force=true to rebuild)',
                    });
                    continue;
                }

                const orgTeam = { organizationId, teamId };

                const jobId = await this.jobQueueService.enqueue({
                    correlationId: teamId,
                    workflowType: WorkflowType.AST_GRAPH_BUILD,
                    handlerType: HandlerType.SIMPLE_FUNCTION,
                    payload: {
                        repositoryId: repoRecord.uuid,
                        cloneUrl: repo.http_url || '',
                        defaultBranch: repoRecord.defaultBranch,
                        fullName: repoRecord.fullName,
                        platform: repoRecord.platform,
                        organizationAndTeamData: orgTeam,
                    },
                    organizationAndTeamData: orgTeam,
                    status: JobStatus.PENDING,
                    priority: 0,
                    retryCount: 0,
                    maxRetries: 3,
                });

                jobIds.push(jobId);

                this.logger.log({
                    message: `[AST-BACKFILL] enqueued ${fullName} (prev status=${status ?? 'NULL'}) jobId=${jobId}`,
                    context: BackfillAstGraphBuildUseCase.name,
                });
            } catch (err) {
                const errorMessage =
                    err instanceof Error ? err.message : String(err);
                errors.push({
                    repositoryId: String(repo.id),
                    error: errorMessage,
                });
                this.logger.error({
                    message: `[AST-BACKFILL] failed to enqueue ${fullName}`,
                    context: BackfillAstGraphBuildUseCase.name,
                    error: err,
                    metadata: {
                        fullName,
                        externalId: String(repo.id),
                        teamId,
                    },
                });
            }
        }

        this.logger.log({
            message: `[AST-BACKFILL] done org=${organizationId} team=${teamId} matched=${selected.length} enqueued=${jobIds.length} skipped=${skipped.length} errors=${errors.length}`,
            context: BackfillAstGraphBuildUseCase.name,
        });

        return {
            matched: selected.length,
            skipped,
            enqueued: jobIds.length,
            jobIds,
            errors,
        };
    }
}
