import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { FinishProjectConfigUseCase } from './finish-project-config.use-case';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { CreateOrUpdateParametersUseCase } from '../../parameters/create-or-update-use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

export class CreateOrUpdateColumnsBoardUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly projectManagementService: ProjectManagementService,
        private readonly finishProjectConfigUseCase: FinishProjectConfigUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    async execute(columns: ColumnsConfigKey[], teamId: string) {
        const team = await this.teamService.findById(teamId);
        const organizationId = this.request.user?.organization?.uuid;

        if (!team) {
            return {
                status: false,
                message: 'Team not found.',
            };
        }

        await this.projectManagementService.createOrUpdateColumns({
            columns,
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
        });

        if (team && ![STATUS.REMOVED, STATUS.ACTIVE].includes(team.status)) {
            await this.teamService.update(
                { uuid: team.uuid },
                { status: STATUS.ACTIVE },
            );
        }

        await this.finishProjectConfigUseCase.execute(teamId);

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
