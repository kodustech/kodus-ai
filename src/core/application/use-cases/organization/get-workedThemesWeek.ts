import { STATUS } from '@/config/types/database/status.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class GetWorkedThemesInWeekByTeams implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly projectManagementService: ProjectManagementService,
        private readonly promptService: PromptService,
        private logger: PinoLoggerService,
    ) {}
    async execute(teamId?: string): Promise<any> {
        const organizationId = this.request.user.organization.uuid;

        try {
            if (teamId) {
                const team = await this.teamService.findById(teamId);

                const result = await this.processForTeam({
                    organizationId,
                    teamId: team.uuid,
                });

                return [
                    {
                        teamId: team.uuid,
                        teamName: team.name,
                        themes: result,
                    },
                ];
            }

            const teams = await this.teamService.find(
                {
                    organization: { uuid: organizationId },
                },
                [STATUS.ACTIVE],
            );

            const teamsResult: {
                teamId: string;
                teamName: string;
                themes: { name: string; count: number }[];
            }[] = [];

            for (const team of teams) {
                const result = await this.processForTeam({
                    organizationId,
                    teamId: team.uuid,
                });

                teamsResult.push({
                    teamId: team.uuid,
                    teamName: team.name,
                    themes: result,
                });
            }

            return teamsResult;
        } catch (error) {
            this.logger.error({
                message: 'Error while executing get worked themes by teams',
                context: GetWorkedThemesInWeekByTeams.name,
                serviceName: 'GetWorkedThemesInWeekByTeams',
                error: error,
                metadata: {
                    organizationId: organizationId,
                },
            });
        }
    }

    private async processForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const columnsConfig: ColumnsConfigResult =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        if (!columnsConfig) return;

        const workItemTypesDefault =
            await this.projectManagementService.getWorkItemsTypes(
                organizationAndTeamData,
                MODULE_WORKITEMS_TYPES.DEFAULT,
            );

        const workItems =
            await this.projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
                {
                    organizationAndTeamData: organizationAndTeamData,
                    filters: {
                        statusesIds: columnsConfig.allColumns
                            .filter(
                                (columnConfig: ColumnsConfigKey) =>
                                    columnConfig.column === 'wip',
                            )
                            .map((columnConfig) => columnConfig.id),
                        workItemTypes: workItemTypesDefault,
                    },
                },
            );

        let llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptGetWorkItemsThemes =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_getWorkedThemesFromItems',
                {
                    organizationAndTeamData,
                    payload: JSON.stringify(workItems),
                    promptIsForChat: false,
                },
            );

        const chain = await llm.invoke(promptGetWorkItemsThemes, {
            metadata: {
                module: 'Cockpit',
                submodule: 'GetWorkedThemes',
            },
        });

        return safelyParseMessageContent(chain.content).workedThemes;
    }
}
