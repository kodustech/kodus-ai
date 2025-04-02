import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { SaveAllTeamMetricsHistoryUseCase } from '../../metrics/save-all-metrics-history.use-case';
import { SaveAllOrganizationMetricsHistoryUseCase } from '../../organizationMetrics/save-metrics-history.use-case';
import { SaveCategoryWorkItemsTypesUseCase } from '../../organizationParameters/save-category-workitems-types.use-case';
import { ExecuteOrganizationArtifactsUseCase } from '../../organizationArtifacts/execute-organization-artifacts.use-case';
import { ExecuteTeamArtifactsUseCase } from '../../teamArtifacts/execute-teamArtifacts';
import { CreateOrUpdateParametersUseCase } from '../../parameters/create-or-update-use-case';
import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { ActiveProjectManagementTeamAutomationsUseCase } from '../../teamAutomation/active-project-management-automations.use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

@Injectable()
export class FinishProjectConfigUseCase implements IUseCase {
    constructor(
        private readonly teamArtifactsUseCase: ExecuteTeamArtifactsUseCase,
        private readonly organizationArtifactsUseCase: ExecuteOrganizationArtifactsUseCase,
        private readonly saveCategoryWorkItemsTypesUseCase: SaveCategoryWorkItemsTypesUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly saveAllTeamMetricsHistoryUseCase: SaveAllTeamMetricsHistoryUseCase,
        private readonly saveAllOrganizationMetricsHistoryUseCase: SaveAllOrganizationMetricsHistoryUseCase,
        private readonly activeProjectManagementTeamAutomationsUseCase: ActiveProjectManagementTeamAutomationsUseCase,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    async execute(teamId: string) {
        const organizationId = this.request.user?.organization?.uuid;

        await this.saveCategoryWorkItemsTypes(teamId, organizationId);

        await this.saveTeamMetrics(teamId, organizationId);

        await this.saveTeamArtifacts(teamId, organizationId);

        await this.activeProjectManagementTeamAutomationsUseCase.execute(
            teamId,
            false,
        );

        await this.savePlatformConfig(teamId, organizationId);

        return;
    }

    private async saveCategoryWorkItemsTypes(
        teamId: string,
        organizationId: string,
    ) {
        await this.saveCategoryWorkItemsTypesUseCase.execute({
            organizationId: organizationId,
            teamId: teamId,
        });
    }

    private async saveTeamMetrics(teamId: string, organizationId: string) {
        await this.saveAllTeamMetricsHistoryUseCase.execute(
            teamId,
            undefined,
            undefined,
            MetricsCategory.FLOW_METRICS,
        );

        await this.saveAllOrganizationMetricsHistoryUseCase.execute(
            organizationId,
            90,
            METRICS_CATEGORY.FLOW_METRICS,
        );
    }

    private async saveTeamArtifacts(teamId: string, organizationId: string) {
        await this.teamArtifactsUseCase.execute({
            teamId: teamId,
            organizationId: organizationId,
            type: 'daily',
        });

        await this.teamArtifactsUseCase.execute({
            teamId: teamId,
            organizationId: organizationId,
            type: 'weekly',
            artifactsToolType: ArtifactsToolType.PROJECT_MANAGEMENT,
        });

        await this.organizationArtifactsUseCase.execute({
            organizationId: organizationId,
            type: 'daily',
        });

        await this.organizationArtifactsUseCase.execute({
            organizationId: organizationId,
            type: 'weekly',
        });
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
                    finishProjectManagementConnection: true,
                },
                { organizationId, teamId },
            );
        }
    }
}
