import { createLogger } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { ActiveCodeManagementTeamAutomationsUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-manegement-automations.use-case';
import { ActiveCodeReviewAutomationUseCase } from '@libs/automation/application/use-cases/teamAutomation/active-code-review-automation.use-case';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
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
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';

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
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
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

            const selectedRepositories =
                params.repositories?.filter(
                    (repo: any) =>
                        repo.selected === true || repo.isSelected === true,
                ) || [];

            if (selectedRepositories.length > 0) {
                setImmediate(() => {
                    this.backfillHistoricalPRsUseCase
                        .execute({
                            organizationAndTeamData: {
                                organizationId,
                                teamId,
                            },
                            repositories: selectedRepositories.map(
                                (r: any) => ({
                                    id: String(r.id),
                                    name: r.name,
                                    fullName:
                                        r.fullName ||
                                        r.full_name ||
                                        `${r.organizationName || ''}/${r.name}`,
                                    url: r.http_url || '',
                                }),
                            ),
                        })
                        .catch((error) => {
                            this.logger.error({
                                message: 'Error during automatic PR backfill',
                                context: CreateRepositoriesUseCase.name,
                                error: error.message,
                                metadata: {
                                    organizationId,
                                    teamId,
                                },
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
}
