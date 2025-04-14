import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { BadRequestException, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { ActiveCodeManagementTeamAutomationsUseCase } from '../../teamAutomation/active-code-manegement-automations.use-case';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import { GenerateCodeArtifactsUseCase } from './generate-code-artifacts.use-case';
import { Injectable } from '@nestjs/common';
import { SaveArtifactsStructureUseCase } from '../../parameters/save-artifacts-structure.use-case';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { CreateOrUpdateParametersUseCase } from '../../parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ActiveCodeReviewAutomationUseCase } from '../../teamAutomation/active-code-review-automation.use-case';

@Injectable()
export class CreateRepositoriesUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly activeCodeManagementTeamAutomationsUseCase: ActiveCodeManagementTeamAutomationsUseCase,

        private readonly activeCodeReviewAutomationUseCase: ActiveCodeReviewAutomationUseCase,

        private readonly generateCodeArtifactsUseCase: GenerateCodeArtifactsUseCase,

        private readonly saveArtifactsStructureUseCase: SaveArtifactsStructureUseCase,

        private readonly codeManagementService: CodeManagementService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(params: any) {
        try {
            const teamId = params?.teamId;
            const organizationId = this.request.user?.organization?.uuid;

            const team = await this.teamService.findById(teamId);

            if (!team) {
                return {
                    status: false,
                    message: 'Team not found.',
                };
            }

            await this.codeManagementService.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: params.repositories,
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
                    false,
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
