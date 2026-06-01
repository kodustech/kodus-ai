import { createLogger } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { ActiveCodeManagementTeamAutomationsUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-manegement-automations.use-case';
import { ActiveCodeReviewAutomationUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-review-automation.use-case';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

// Orgs with a historical-PR backfill currently in flight. registerRepo
// is fired on every onboarding save (and can be retried client-side), so
// without this guard a double-save kicks off two concurrent backfills
// that each fan out over the same repos and double the provider load —
// exactly the burst that 429s Bitbucket. In-memory + per-process is
// enough: the backfill always runs in the API process that handled the
// HTTP request.
const backfillInFlight = new Set<string>();

@Injectable()
export class CreateRepositoriesUseCase implements IUseCase {
    private readonly logger = createLogger(CreateRepositoriesUseCase.name);
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly activeCodeManagementTeamAutomationsUseCase: ActiveCodeManagementTeamAutomationsUseCase,
        private readonly activeCodeReviewAutomationUseCase: ActiveCodeReviewAutomationUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid?: string };
        },
        private readonly telemetry: TelemetryService,
    ) {}

    public async execute(params: any) {
        try {
            const teamId = params?.teamId;
            const organizationId =
                params?.organizationId ??
                this.request?.user?.organization?.uuid;

            const team = await this.teamService.findById(teamId);

            if (!team) {
                return {
                    status: false,
                    message: 'Team not found.',
                };
            }

            if (!organizationId) {
                throw new BadRequestException('Organization ID is required.');
            }

            await this.codeManagementService.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: params.repositories,
                type: params.type,
                organizationAndTeamData: {
                    teamId: teamId,
                    organizationId: organizationId,
                },
            });

            if (
                team &&
                ![STATUS.REMOVED, STATUS.ACTIVE].includes(team.status)
            ) {
                await this.teamService.update(
                    { uuid: team.uuid },
                    { status: STATUS.ACTIVE },
                );
            }

            const codeManagementTeamAutomations =
                await this.activeCodeManagementTeamAutomationsUseCase.execute(
                    teamId,
                );

            await this.activeCodeReviewAutomationUseCase.execute(
                teamId,
                codeManagementTeamAutomations,
            );

            const teams = await this.teamService.find(
                { organization: { uuid: organizationId } },
                [STATUS.ACTIVE],
            );

            if (teams && teams?.length > 1) {
                this.savePlatformConfig(teamId, organizationId);
            }

            const repositories = params.repositories || [];

            const backfillKey = `${organizationId}:${teamId}`;
            if (repositories.length > 0) {
                // Single-flight: registerRepo fires on every onboarding
                // save (and can be retried client-side); without this a
                // double-save kicks off two concurrent backfills that each
                // fan out over the same repos and double the provider
                // load — the burst that 429s Bitbucket.
                if (!backfillInFlight.has(backfillKey)) {
                    backfillInFlight.add(backfillKey);
                    setImmediate(() => {
                        this.backfillHistoricalPRsUseCase
                            .execute({
                                organizationAndTeamData: {
                                    organizationId,
                                    teamId,
                                },
                                repositories: repositories.map((r: any) => ({
                                    id: String(r.id),
                                    name: r.name,
                                    fullName:
                                        r.fullName ||
                                        r.full_name ||
                                        `${r.organizationName || ''}/${r.name}`,
                                    url: r.http_url || '',
                                })),
                            })
                            .catch((error) => {
                                this.logger.error({
                                    message: `Error during automatic PR backfill: ${error?.message || String(error)}`,
                                    context: CreateRepositoriesUseCase.name,
                                });
                            })
                            .finally(() =>
                                backfillInFlight.delete(backfillKey),
                            );
                    });
                } else {
                    this.logger.log({
                        message:
                            'Skipping PR backfill — one is already in flight for this org/team',
                        context: CreateRepositoriesUseCase.name,
                        metadata: { organizationId, teamId },
                    });
                }

                setImmediate(() => {
                    this.enqueueAstGraphBuilds(repositories, {
                        organizationId,
                        teamId,
                    }).catch((error) => {
                        this.logger.error({
                            message: `Error enqueuing AST graph builds: ${error?.message || String(error)}`,
                            context: CreateRepositoriesUseCase.name,
                        });
                    });
                });
            }

            return {
                status: true,
            };
        } catch (error) {
            throw new BadRequestException(error);
        }
    }

    private async savePlatformConfig(teamId: string, organizationId: string) {
        const platformConfig = await this.parametersService.findByKey(
            ParametersKey.PLATFORM_CONFIGS,
            { organizationId, teamId },
        );

        if (platformConfig) {
            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    finishOnboard: true,
                },
                { organizationId, teamId },
            );
        }
    }

    private async enqueueAstGraphBuilds(
        repositories: Array<{
            id: string;
            name: string;
            fullName?: string;
            full_name?: string;
            http_url?: string;
            organizationName?: string;
            default_branch?: string;
        }>,
        orgTeam: { organizationId: string; teamId: string },
    ): Promise<void> {
        const platformType =
            (await this.codeManagementService.getTypeIntegration(orgTeam)) ||
            'github';

        this.logger.log({
            message: `[AST-GRAPH] Processing ${repositories.length} repos for AST graph build (platform=${platformType})`,
            context: CreateRepositoriesUseCase.name,
            metadata: {
                repos: repositories.map((r: any) => ({
                    id: r.id,
                    name: r.name,
                })),
            },
        });

        for (const repo of repositories) {
            try {
                const nameAlreadyHasNamespace = (repo.name || '').includes('/');
                const fullName =
                    repo.fullName ||
                    repo.full_name ||
                    (nameAlreadyHasNamespace
                        ? repo.name
                        : `${repo.organizationName || ''}/${repo.name}`);

                const repoRecord = await this.repositoryService.findOrCreate({
                    integrationConfigId: orgTeam.teamId,
                    externalId: String(repo.id),
                    name: repo.name,
                    fullName,
                    platform: platformType,
                    defaultBranch: repo.default_branch,
                });

                void this.telemetry.repositoryConnected({
                    repositoryId: repoRecord.externalId,
                    name: repoRecord.name,
                    fullName: repoRecord.fullName,
                    platform: repoRecord.platform,
                    organizationId: orgTeam.organizationId,
                    agentReviewEnabled: true,
                    actorUserId: this.request?.user?.uuid,
                });

                // Only enqueue if graph not already ready or building
                if (
                    repoRecord.astGraphStatus === AstGraphStatus.PENDING ||
                    repoRecord.astGraphStatus === AstGraphStatus.FAILED
                ) {
                    await this.jobQueueService.enqueue({
                        correlationId: orgTeam.teamId,
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

                    this.logger.log({
                        message: `[AST-GRAPH] Enqueued full build for ${fullName}`,
                        context: CreateRepositoriesUseCase.name,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: `[AST-GRAPH] Failed to enqueue build for repo ${repo.name}: ${error?.message || String(error)}`,
                    context: CreateRepositoriesUseCase.name,
                });
                // Continue with other repos — don't let one failure block the rest
            }
        }
    }
}
