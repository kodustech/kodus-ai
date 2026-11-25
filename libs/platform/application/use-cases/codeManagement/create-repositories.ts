import { createLogger } from '@libs/core/log/logger';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { ActiveCodeManagementTeamAutomationsUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-manegement-automations.use-case';
import { ActiveCodeReviewAutomationUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-review-automation.use-case';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
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
import { RepositoryConnectionService } from '@libs/platform/application/services/repository-sync/repository-connection.service';
import { RepositorySelectionConfig } from '@libs/platform/application/services/repository-sync/repository-sync.types';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';


@Injectable()
export class CreateRepositoriesUseCase implements IUseCase {
    private readonly logger = createLogger(CreateRepositoriesUseCase.name);
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly activeCodeManagementTeamAutomationsUseCase: ActiveCodeManagementTeamAutomationsUseCase,
        private readonly activeCodeReviewAutomationUseCase: ActiveCodeReviewAutomationUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly repositoryConnectionService: RepositoryConnectionService,
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

            const previouslyPersistedRepoIds = new Set(
                (
                    (await this.integrationConfigService.findIntegrationConfigFormatted<
                        Array<{ id: string | number }>
                    >(IntegrationConfigKey.REPOSITORIES, {
                        organizationId,
                        teamId,
                    })) ?? []
                ).map((repo) => String(repo.id)),
            );

            await this.assertNoRemovalInAllMode(
                { organizationId, teamId },
                params,
                previouslyPersistedRepoIds,
            );

            await this.codeManagementService.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: params.repositories,
                type: params.type,
                // Forwarded so the adapters can tell an intermediate chunk of
                // a chunked save from an authoritative one. Absent means
                // authoritative, which is what every other caller sends.
                deferWebhooks: params.deferWebhooks,
                organizationAndTeamData: {
                    teamId: teamId,
                    organizationId: organizationId,
                },
            });

            // One event per save, beside the per-repo `repository_connected`
            // ones: the setup funnel step is "picked repositories", not
            // "picked the seventh repository". A chunked save reports each
            // chunk, so `deferWebhooks` marks the non-authoritative ones.
            const selectedRepoIds: string[] = (params.repositories ?? []).map(
                (repo: { id: string | number }) => String(repo.id),
            );
            void this.telemetry.repositoriesSelected({
                organizationId,
                teamId,
                actorUserId: this.request?.user?.uuid,
                platform: params.type,
                selectedCount: selectedRepoIds.length,
                addedCount: selectedRepoIds.filter(
                    (id) => !previouslyPersistedRepoIds.has(id),
                ).length,
                removedCount: [...previouslyPersistedRepoIds].filter(
                    (id) => !selectedRepoIds.includes(id),
                ).length,
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
            const reposToBackfill = repositories.filter(
                (r: any) => !previouslyPersistedRepoIds.has(String(r.id)),
            );

            if (repositories.length > 0) {
                if (reposToBackfill.length === 0) {
                    this.logger.log({
                        message:
                            'Skipping PR backfill — no newly-added repositories in this request',
                        context: CreateRepositoriesUseCase.name,
                        metadata: {
                            organizationId,
                            teamId,
                            totalRepositories: repositories.length,
                        },
                    });
                } else {
                    this.repositoryConnectionService.startHistoricalBackfill(
                        { organizationId, teamId },
                        reposToBackfill,
                    );
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

    /**
     * In "review all repositories" mode the sync adds every repository back,
     * so a save that drops one would silently undo itself. Turning automated
     * review off for the repository is the way to exclude it.
     */
    private async assertNoRemovalInAllMode(
        organizationAndTeamData: { organizationId: string; teamId: string },
        params: {
            type?: string;
            repositories?: Array<{ id: string | number }>;
        },
        previouslyPersistedRepoIds: Set<string>,
    ): Promise<void> {
        // A chunked save opens with a partial `replace`, so it counts too: in
        // this mode the selection only grows.
        if (params.type === 'append') {
            return;
        }

        const selection =
            await this.integrationConfigService.findIntegrationConfigFormatted<RepositorySelectionConfig>(
                IntegrationConfigKey.REPOSITORY_SELECTION,
                organizationAndTeamData,
            );

        if (selection?.mode !== 'all') {
            return;
        }

        const nextIds = new Set(
            (params.repositories ?? []).map((repo) => String(repo.id)),
        );
        const removed = [...previouslyPersistedRepoIds].filter(
            (id) => !nextIds.has(id),
        );

        if (removed.length) {
            this.logger.warn({
                message:
                    'Rejected a repository removal while the team reviews all repositories',
                context: CreateRepositoriesUseCase.name,
                metadata: { ...organizationAndTeamData, removed },
            });
            throw new BadRequestException(
                'This team reviews every repository automatically, so repositories cannot be removed. Turn off automated review for the repository instead.',
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
                repos: repositories.map((r) => ({ id: r.id, name: r.name })),
            },
        });

        const registered =
            await this.repositoryConnectionService.registerRepositoryRecords({
                organizationAndTeamData: orgTeam,
                platform: platformType,
                repositories,
                actorUserId: this.request?.user?.uuid,
            });

        for (const { repository, record } of registered) {
            try {
                await this.repositoryConnectionService.enqueueAstBuild({
                    organizationAndTeamData: orgTeam,
                    record,
                    cloneUrl: repository.http_url,
                });
            } catch (error) {
                this.logger.error({
                    message: `[AST-GRAPH] Failed to enqueue build for repo ${repository.name}: ${error?.message || String(error)}`,
                    context: CreateRepositoriesUseCase.name,
                });
            }
        }
    }
}
