import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PromptService } from '../../../prompt.service';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import { IAutomationExecutiveCheckinService } from '@/core/domain/automation/contracts/automation-executiveCheckin.service';
import {
    IOrganizationAutomationService,
    ORGANIZATION_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/organization-automation.service';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { IOrganizationAutomation } from '@/core/domain/automation/interfaces/organization-automation.interface';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import {
    IntegrationStatusFilter,
    ITeam,
    ITeamWithIntegrations,
} from '@/core/domain/team/interfaces/team.interface';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { ProfileConfigService } from '../../../profileConfig.service';
import { PROFILE_CONFIG_SERVICE_TOKEN } from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import * as moment from 'moment-timezone';
import { CHECKIN_TYPE } from '@/core/domain/checkinHistory/enums/checkin-type.enum';
import {
    IOrganizationAutomationExecutionService,
    ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/organization-automation-execution.service';
import { PinoLoggerService } from '../../../logger/pino.service';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { ValidateCommunicationManagementIntegration } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';

@Injectable()
export class AutomationExecutiveCheckin
    implements
        Omit<IAutomationFactory, 'stop'>,
        IAutomationExecutiveCheckinService
{
    automationType = AutomationType.AUTOMATION_EXECUTIVE_CHECKIN;
    constructor(
        @Inject(ORGANIZATION_AUTOMATION_SERVICE_TOKEN)
        private readonly organizationAutomationService: IOrganizationAutomationService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        @Inject(ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly organizationAutomationExecutionService: IOrganizationAutomationExecutionService,

        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: ProfileConfigService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        private readonly communicationService: CommunicationService,

        private readonly promptService: PromptService,

        private readonly logger: PinoLoggerService,
    ) {}
    async setup(payload?: any): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            const organizationAutomation: IOrganizationAutomation = {
                status: true,
                automation: {
                    uuid: automation.uuid,
                },
                organization: {
                    uuid: payload.organizationId,
                },
            };

            return this.organizationAutomationService.register(
                organizationAutomation,
            );
        } catch (error) {
            console.log('Error creating automation for the team', error);
        }
    }

    @ValidateCommunicationManagementIntegration({
        allowPartialTeamConnection: true,
    })
    async run?(payload?: {
        organizationId: string;
        organizationAutomationId: string;
        todayDate?: Date;
        origin?: string;
    }): Promise<any> {
        try {
            const { organizationId, organizationAutomationId, origin } =
                payload;

            const teams = await this.getTeams(organizationId);

            const maximumAmountOfTeamsPerMessage = 25;

            let splitTeams = this.splitArray(
                teams,
                maximumAmountOfTeamsPerMessage,
            );

            let splitTeamsWithSummary = [];

            for (const teamGroup of splitTeams) {
                let teamsSummary = await this.getTeamsSummary({
                    teams: teamGroup,
                    organizationId,
                });

                const teamsWithTeamSummary = teamGroup.map((team, index) => {
                    return { ...team, teamSummary: teamsSummary[index] };
                });

                splitTeamsWithSummary.push(teamsWithTeamSummary);
            }

            for (const teamsWithTeamSummary of splitTeamsWithSummary) {
                await this.sendMessages({
                    organizationId: organizationId,
                    teamsWithTeamSummary: teamsWithTeamSummary,
                    organizationAutomationId,
                    origin,
                });
            }

            return 'Automation executed successfully';
        } catch (error) {
            this.logger.error({
                message: 'Error executing executive check-in automation',
                context: AutomationExecutiveCheckin.name,
                error: error,
            });

            throw error;
        }
    }

    private async getTeamsSummary(data: { teams; organizationId }) {
        const { teams, organizationId } = data;

        let teamsSummary = [];

        for (const team of teams) {
            const metrics = await this.prepareMetrics(
                {
                    organizationId: organizationId,
                    teamId: team.uuid,
                },
                team,
            );

            const summarizedMetrics = await this.getMetricsSummary({
                metrics,
                organizationId,
                teamId: team.uuid,
            });

            const artifacts = await this.getTeamArtifacts(organizationId, team);

            const mostImportantArtifactSumary =
                await this.getMostImportantTeamArtifactSummary({
                    artifacts,
                    organizationId,
                    teamId: team.uuid,
                });

            const teamSummary = `${summarizedMetrics}\n\n${mostImportantArtifactSumary}`;

            teamsSummary.push(teamSummary);
        }
        return teamsSummary;
    }

    private splitArray(arr: any[], maxNumberOfElements: number) {
        const result = [];

        for (let i = 0; i < arr.length; i += maxNumberOfElements) {
            result.push(arr.slice(i, i + maxNumberOfElements));
        }

        return result;
    }

    private async sendMessages(params: {
        organizationId: string;
        teamsWithTeamSummary: any;
        organizationAutomationId: string;
        origin?: string;
    }) {
        const {
            organizationId,
            teamsWithTeamSummary,
            organizationAutomationId,
            origin,
        } = params;

        const configValue = (
            await this.profileConfigService.findProfileConfigOrganizationOwner(
                organizationId,
            )
        ).configValue;

        const communicationId = configValue.communicationId;

        const message = await this.communicationService.handlerTemplateMessage({
            methodName: 'constructExecutiveCheckinBlocks',
            organizationAndTeamData: {
                organizationId: organizationId,
                teamId: null,
            },
            teamsWithTeamSummary,
        });

        if (!message) {
            throw new Error('Error constructing executive check-in template');
        }

        let teamsIds: string[] = [];

        for (const team of teamsWithTeamSummary) {
            teamsIds.push(team.uuid);
        }

        this.communicationService.saveCheckinHistoryOrganization({
            teamsIds: teamsIds,
            organizationId: organizationId,
            date: new Date(),
            message: message,
            type: CHECKIN_TYPE.EXECUTIVE,
        });

        if (communicationId && message) {
            this.communicationService.newBlockMessage({
                organizationAndTeamData: { organizationId },
                blocks: message,
                channelId: communicationId,
            });
        }

        this.createOrganizationAutomationExecution(
            {
                channelIds: [communicationId],
                organizationId: organizationId,
            },
            organizationAutomationId,
            origin,
        );
    }

    private createOrganizationAutomationExecution(
        data: any,
        organizationAutomationId: string,
        origin: string,
    ) {
        const automationExecution = {
            status: AutomationStatus.SUCCESS,
            dataExecution: data,
            organizationAutomation: { uuid: organizationAutomationId },
            origin,
        };

        this.organizationAutomationExecutionService.register(
            automationExecution,
        );
    }

    private async getTeams(organizationId: string) {
        const teams = await this.teamService.findTeamsWithIntegrations({
            organizationId,
            status: STATUS.ACTIVE,
            integrationCategories: [IntegrationCategory.COMMUNICATION],
            integrationStatus: IntegrationStatusFilter.CONFIGURED,
        });

        const teamsInJSON = teams.map((team) => ({
            uuid: team.uuid,
            name: team.name,
            organization: team.organization,
            status: team.status,
            hasCodeManagement: team.hasCodeManagement,
            hasProjectManagement: team.hasProjectManagement,
            hasCommunication: team.hasCommunication,
            isCodeManagementConfigured: team.isCodeManagementConfigured,
            isProjectManagementConfigured: team.isProjectManagementConfigured,
            isCommunicationConfigured: team.isCommunicationConfigured,
        }));

        return teamsInJSON;
    }

    async getTeamArtifacts(organizationId: string, team: Partial<ITeam>) {
        const artifacts =
            await this.teamArtifactsService.getMostRecentArtifactVisible(
                { organizationId, teamId: team.uuid },
                null,
            );

        if (!artifacts || artifacts?.length <= 0) {
            return [];
        }

        return artifacts
            .map((artifact) => {
                return {
                    uuid: artifact.uuid,
                    title: artifact.title,
                    name: artifact.name,
                    analysisInitialDate: moment(
                        artifact.analysisInitialDate,
                    ).format('DD/MM/YYYY'),
                    analysisFinalDate: moment(
                        artifact.analysisFinalDate,
                    ).format('DD/MM/YYYY'),
                    category: artifact.category,
                    description: artifact.description,
                    relatedItems: artifact.relatedItems,
                    criticality: artifact.criticality,
                    resultType: artifact.resultType,
                    impactArea: artifact.impactArea,
                    howIsIdentified: artifact.howIsIdentified,
                    whyIsImportant: artifact.whyIsImportant,
                    teamId: artifact.teamId,
                    organizationId: artifact.organizationId,
                    frequenceType: artifact.frequenceType,
                    teamMethodology: artifact.teamMethodology,
                    impactLevel: artifact.impactLevel,
                };
            })
            .sort((a, b) => b.impactLevel - a.impactLevel);
    }

    private async prepareMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
        team: Partial<ITeamWithIntegrations>,
    ): Promise<any> {
        let filteredMetrics = [];

        if (team?.isProjectManagementConfigured) {
            const flowMetrics =
                await this.metricsService.compareCurrentAndLastWeekFlowMetrics(
                    organizationAndTeamData,
                );

            flowMetrics?.map((metric: any) => {
                const filteredMetric = {
                    name: metric.name,
                    result: metric.result,
                    resultType: metric.resultType,
                    difference: metric.difference,
                };

                filteredMetrics.push(filteredMetric);
            });
        }

        if (team?.isCodeManagementConfigured) {
            const doraMetrics =
                await this.metricsService.compareCurrentAndLastWeekDoraMetrics(
                    organizationAndTeamData,
                );

            doraMetrics?.map((metric: any) => {
                const filteredMetric = {
                    name: metric.name,
                    result: metric.result,
                    resultType: metric.resultType,
                    resultObs: metric?.resultObs,
                    difference: metric.difference,
                };

                filteredMetrics.push(filteredMetric);
            });
        }

        return filteredMetrics;
    }

    private async getMetricsSummary(params: {
        metrics: any;
        teamId: string;
        organizationId: string;
    }) {
        const { metrics, teamId, organizationId } = params;

        const promptExecutiveCheckinResumeMetrics =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_executiveCheckin_resumeMetrics',
                {
                    organizationAndTeamData: { organizationId, teamId },
                    payload: JSON.stringify({ data: metrics }),
                    promptIsForChat: false,
                },
            );

        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_ALL,
            ),
            temperature: 0,
        });

        const resumedMetrics = (
            await llm.invoke(promptExecutiveCheckinResumeMetrics, {
                metadata: {
                    module: 'AutomationExecutiveCheckin',
                    organizationId: organizationId,
                },
            })
        ).content;

        return resumedMetrics;
    }

    private async getMostImportantTeamArtifactSummary(params: {
        artifacts: any;
        teamId: string;
        organizationId: string;
    }) {
        const { artifacts, teamId, organizationId } = params;

        const promptExecutiveCheckinResumeImportantArtifacts =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_executiveCheckin_resumeImportantArtifact',
                {
                    organizationAndTeamData: { organizationId, teamId },
                    payload: JSON.stringify({ data: artifacts }),
                    promptIsForChat: false,
                },
            );

        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_ALL,
            ),
            temperature: 0,
        });

        const mostImportantArtifactSummary = (
            await llm.invoke(promptExecutiveCheckinResumeImportantArtifacts, {
                metadata: {
                    module: 'AutomationExecutiveCheckin',
                    organizationId: organizationId,
                },
            })
        ).content;

        return mostImportantArtifactSummary;
    }
}
