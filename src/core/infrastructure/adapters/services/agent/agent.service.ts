import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import {
    ISessionService,
    SESSION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/session.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PromptRouter } from './config/promptRouter';
import { IAgentService } from '@/core/domain/agents/contracts/agent.service.contracts';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    ExecutionRouterPromptParams,
    RouterPromptParams,
} from '@/config/types/general/agentRouter.type';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { CommunicationService } from '../platformIntegration/communication.service';
import {
    METRICS_FACTORY_TOKEN,
    IMetricsFactory,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AuthDetailsParams } from '@/core/domain/agents/types/auth-details-params.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { PinoLoggerService } from '../logger/pino.service';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { ProfileConfigKey } from '@/core/domain/profileConfigs/enum/profileConfigKey.enum';
import { TeamMemberRole } from '@/core/domain/teamMembers/enums/teamMemberRole.enum';
import { STATUS } from '@/config/types/database/status.type';
import {
    DoraMetricsResults,
    FlowMetricsResults,
    MetricsConversionStructure,
} from '@/shared/domain/interfaces/metrics';
import { IDoraMetricsFactory } from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { DORA_METRICS_FACTORY_TOKEN } from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { TeamMetricsMapper } from '../metrics/formatCommunicationPlatform/teamMetrics.mapper';
import { generateFlowMetricsConfig } from '@/shared/utils/metrics/generateFlowMetricsConfig.utils';
import { MetricsAnalysisInterval } from '@/shared/utils/metrics/metricsAnalysisInterval.enum';
import { generateDoraMetricsConfig } from '@/shared/utils/metrics/generateDoraMetricsConfig.utils';
import { ColumnsForMetricsMessage } from '../metrics/formatCommunicationPlatform/metrics.formatter';
import {
    CodeManagementConnectionStatus,
    ValidateCodeManagementIntegration,
} from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import {
    ProjectManagementConnectionStatus,
    ValidateProjectManagementIntegration,
} from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';

@Injectable()
export class AgentService implements IAgentService {
    constructor(
        @Inject(SESSION_SERVICE_TOKEN)
        private readonly sessionService: ISessionService,
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IDoraMetricsFactory,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: IProfileConfigService,

        private readonly promptRouter: PromptRouter,

        private readonly projectManagementService: ProjectManagementService,

        private readonly codeManagementService: CodeManagementService,

        private readonly communication: CommunicationService,

        private logger: PinoLoggerService,
    ) {}

    async handlerCheckMultiConfigurationTeams(
        routerPromptParams: RouterPromptParams,
    ): Promise<any> {
        try {
            let contextTeamMemberType = {
                userType: '',
                isChannelBelongsTeam: false, // Channel belongs to a team
                teams: [],
            };

            // Fetches the integrationConfig based on channelId
            const integrationConfigService =
                await this.integrationConfigService.findOne({
                    configKey: routerPromptParams?.authDetailsParams
                        ?.integrationConfig
                        ?.identifierKey as IntegrationConfigKey,
                    configValue: {
                        channelId:
                            routerPromptParams?.authDetailsParams
                                ?.integrationConfig?.identifierValue,
                    },
                });

            // Fetches the teamMembers based on the communication ID of the person who sent the message
            const teamMembers =
                await this.teamMembersService.findMembersByCommunicationId(
                    routerPromptParams?.authDetailsParams?.userCommunicationData
                        ?.communicationId,
                );

            if (teamMembers && teamMembers?.length > 0) {
                // Filters the members according to the integrationConfig, meaning if a team is configured, it filters the teamMembers that belong to the team.
                const filteredTeamMembers = integrationConfigService
                    ? teamMembers.filter(
                          (t) =>
                              t.team.uuid ===
                              integrationConfigService.team.uuid,
                          integrationConfigService.team.status ===
                              STATUS.ACTIVE,
                      )
                    : teamMembers;

                const allAreProjectLeaders = filteredTeamMembers.every(
                    (member) => member.teamRole === TeamMemberRole.TEAM_LEADER,
                );

                if (allAreProjectLeaders) {
                    contextTeamMemberType.teams = [
                        ...filteredTeamMembers.map((t) => t.team.uuid),
                    ];

                    contextTeamMemberType.userType = TeamMemberRole.TEAM_LEADER;
                } else if (
                    !allAreProjectLeaders &&
                    filteredTeamMembers.length === 1
                ) {
                    contextTeamMemberType.teams = [
                        ...filteredTeamMembers.map((t) => t.team.uuid),
                    ];

                    contextTeamMemberType.userType = TeamMemberRole.MEMBER;
                } else {
                    contextTeamMemberType.userType = 'NOT REGISTERED';
                }
            } else {
                const profileConfigService =
                    await this.profileConfigService.findOne({
                        configKey: ProfileConfigKey.USER_NOTIFICATIONS,
                        configValue: {
                            communicationId:
                                routerPromptParams?.authDetailsParams
                                    ?.userCommunicationData?.communicationId,
                        },
                    });

                contextTeamMemberType.userType = profileConfigService
                    ? 'Company Leader'
                    : 'NOT REGISTERED';
            }

            if (
                contextTeamMemberType.userType === 'Company Leader' &&
                integrationConfigService
            ) {
                contextTeamMemberType.teams = [
                    integrationConfigService?.team?.uuid,
                ];
            }

            contextTeamMemberType.isChannelBelongsTeam =
                !!integrationConfigService;

            if (
                contextTeamMemberType.userType === TeamMemberRole.MEMBER &&
                !contextTeamMemberType?.teams?.includes(
                    integrationConfigService?.team?.uuid,
                )
            ) {
                contextTeamMemberType.isChannelBelongsTeam = false;
            }

            return contextTeamMemberType;
        } catch (error) {
            this.logger.error({
                message: 'Error executing handlerCommunicationTool',
                context: AgentService.name,
                error: error,
            });
        }
    }

    async getAuthDetailsByOrganization(filter: any) {
        return await this.integrationService.getFullIntegrationDetails(
            filter.organizationAndTeamData,
            filter.platformName,
        );
    }

    async createSession(
        platformUserId: string,
        platformName: string,
        route: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            return await this.sessionService.register({
                platformUserId: platformUserId,
                platformName: platformName,
                route: route,
                date: Date.now(),
                teamId: organizationAndTeamData?.teamId,
                organizationId: organizationAndTeamData?.organizationId,
            });
        } catch (error) {
            console.log(error);
        }
    }

    async getMemory(sessionId: string): Promise<any> {
        try {
            return await this.memoryService.findBySessionId(sessionId);
        } catch (error) {
            console.log(error);
        }
    }

    async getRouter(routerPromptParams: RouterPromptParams): Promise<any> {
        try {
            let hasTeamContext = false;
            let router = undefined;

            const contextTeamMemberType =
                await this.handlerCheckMultiConfigurationTeams(
                    routerPromptParams,
                );

            if (
                !routerPromptParams?.organizationAndTeamData?.teamId &&
                contextTeamMemberType &&
                contextTeamMemberType.userType === 'Company Leader' &&
                !contextTeamMemberType.isChannelBelongsTeam &&
                (contextTeamMemberType.teams?.length > 1 ||
                    contextTeamMemberType.teams?.length === 0)
            ) {
                hasTeamContext = false;
            } else if (
                !routerPromptParams?.organizationAndTeamData?.teamId &&
                !contextTeamMemberType.isChannelBelongsTeam &&
                contextTeamMemberType.teams?.length === 0 &&
                (contextTeamMemberType.userType === TeamMemberRole.MEMBER ||
                    contextTeamMemberType.userType === 'NOT REGISTERED')
            ) {
                hasTeamContext = false;
                routerPromptParams.parameters = [
                    {
                        hasError: true,
                        type: 'Engineer',
                    },
                ];
            } else if (
                !routerPromptParams?.organizationAndTeamData?.teamId &&
                !contextTeamMemberType.isChannelBelongsTeam &&
                contextTeamMemberType.userType === TeamMemberRole.TEAM_LEADER &&
                contextTeamMemberType.teams?.length > 1
            ) {
                hasTeamContext = false;
            } else {
                hasTeamContext = true;
                routerPromptParams.organizationAndTeamData.teamId =
                    routerPromptParams?.organizationAndTeamData?.teamId ||
                    contextTeamMemberType?.teams[0];

                router =
                    await this.promptRouter.routerPrompt(routerPromptParams);

                if (router?.parameters) {
                    routerPromptParams.parameters = [...router.parameters];
                }
            }

            return {
                ...router,
                organizationAndTeamData:
                    routerPromptParams.organizationAndTeamData,
                parameters: routerPromptParams?.parameters,
                platformType: routerPromptParams?.platformType,
                route: hasTeamContext ? router.route : 'teamSelectionAgent',
            };
        } catch (error) {
            console.log(error);
        }
    }

    async executionRouterPrompt(
        executionRouterPromptParams: ExecutionRouterPromptParams,
    ): Promise<any> {
        try {
            return await this.promptRouter.executionRouterPrompt(
                executionRouterPromptParams,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async checkIfHasActiveSessions(
        platformUserId: string,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            return await this.sessionService.checkIfHasActiveSessions(
                platformUserId,
                organizationAndTeamData,
            );
        } catch (error) {}
    }

    async getAuthDetails(
        filters: AuthDetailsParams,
    ): Promise<OrganizationAndTeamData> {
        try {
            if (!filters?.authIntegration?.identifierValue) {
                return null;
            }

            const authIntegration = await this.authIntegrationService.findOne({
                authDetails: {
                    [filters.authIntegration.identifierKey]:
                        filters.authIntegration.identifierValue,
                },
            });

            const integrationConfigService =
                await this.integrationConfigService.findOne({
                    configKey: filters?.integrationConfig
                        ?.identifierKey as IntegrationConfigKey,
                    configValue: {
                        channelId: filters?.integrationConfig?.identifierValue,
                    },
                });

            if (!authIntegration) {
                return null;
            }

            return {
                authDetails: { ...authIntegration?.authDetails },
                organizationId: authIntegration?.organization?.uuid,
                teamId: integrationConfigService?.team?.uuid,
            } as OrganizationAndTeamData;
        } catch (error) {
            console.log(error);
        }
    }

    async sendMetricMessage(
        organizationAndTeamData: OrganizationAndTeamData,
        channelId: string,
        language: LanguageValue,
    ): Promise<any> {
        try {
            const columns = await this.getFormatedColumns(
                organizationAndTeamData.organizationId,
            );

            const doraMetricsMapped =
                await this.generateDoraMetricsNotification(
                    organizationAndTeamData,
                );

            const flowMetricsMapped =
                await this.generateFlowMetricsNotification(
                    organizationAndTeamData,
                );

            const metrics = {
                ...(flowMetricsMapped
                    ? { flowMetrics: flowMetricsMapped }
                    : {}),
                ...(doraMetricsMapped
                    ? { doraMetrics: doraMetricsMapped }
                    : {}),
            };

            const formattedMetrics =
                await this.communication.formatMetricsMessage({
                    metrics,
                    organizationAndTeamData,
                    columns,
                    language,
                });

            if (!formattedMetrics) {
                const template = await this.constructErrorMessageTemplate(
                    organizationAndTeamData,
                    'No information found at the moment for processing the metrics.',
                );

                await this.communication.newBlockMessage({
                    organizationAndTeamData,
                    blocks: template,
                    channelId: channelId,
                });
            }

            await this.communication.newBlockMessage({
                organizationAndTeamData,
                blocks: formattedMetrics,
                channelId: channelId,
            });
        } catch (error) {
            console.log('SendMetricMessage - error:', error);
            return null;
        }
    }

    @ValidateCodeManagementIntegration()
    private async generateDoraMetricsNotification(
        organizationAndTeamData: OrganizationAndTeamData,
        integrationStatus?: CodeManagementConnectionStatus,
    ) {
        if (!integrationStatus?.isSetupComplete) {
            return null;
        }

        const teamMetricsMapper = new TeamMetricsMapper();

        const doraMetrics = await this.getDoraMetrics(organizationAndTeamData);

        const metrics = await teamMetricsMapper.mapTeamMetrics(
            null,
            doraMetrics,
        );

        return metrics;
    }

    @ValidateProjectManagementIntegration({ onlyCheckConnection: true })
    private async generateFlowMetricsNotification(
        organizationAndTeamData: OrganizationAndTeamData,
        integrationStatus?: ProjectManagementConnectionStatus,
    ) {
        if (!integrationStatus?.isSetupComplete) {
            return null;
        }

        const teamMetricsMapper = new TeamMetricsMapper();

        const flowMetrics = await this.getFlowMetrics(organizationAndTeamData);

        const flowMetricsMapped = await teamMetricsMapper.mapTeamMetrics(
            flowMetrics,
            null,
        );

        return flowMetricsMapped;
    }

    async constructErrorMessageTemplate(
        organizationAndTeamData: OrganizationAndTeamData,
        errorMessage?: string,
    ): Promise<any> {
        return await this.communication.handlerTemplateMessage({
            methodName: 'getDefaultMessageErrorProcessCommands',
            organizationAndTeamData,
            errorMessage,
        });
    }

    async conversationWithKody(
        organizationAndTeamData: OrganizationAndTeamData,
        platformUserId: string,
        message: string,
        userName?: string,
        sessionId?: string,
    ): Promise<any> {
        let session = null;

        if (!sessionId) {
            session = await this.checkIfHasActiveSessions(
                platformUserId,
                organizationAndTeamData,
            );
        } else {
            session = {
                uuid: sessionId,
            };
        }

        const router = await this.getRouter({
            organizationAndTeamData,
            message,
            sessionId: session?.uuid,
        });

        if (router && !session) {
            session = await this.createSession(
                platformUserId,
                PlatformType.GITHUB,
                router.route,
                organizationAndTeamData,
            );
        }

        const response = await this.executionRouterPrompt({
            message,
            router,
            userId: platformUserId,
            channel: '',
            sessionId: session?.uuid,
            userName: userName,
            organizationAndTeamData,
        });

        return response;
    }

    executeTools(
        tools: any,
        organizationAndTeamData: OrganizationAndTeamData,
        platformType?: PlatformType,
    ) {
        throw new Error('Method not implemented.');
    }

    private async getFlowMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<FlowMetricsResults> {
        const flowMetricsConfig = await generateFlowMetricsConfig({
            interval: MetricsAnalysisInterval.LAST_TWO_WEEKS,
        });

        const flowMetrics =
            await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                flowMetricsConfig,
            );

        return flowMetrics;
    }

    private async getDoraMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<DoraMetricsResults> {
        const doraMetricsConfig = await generateDoraMetricsConfig({
            interval: MetricsAnalysisInterval.LAST_TWO_WEEKS,
        });

        const doraMetrics =
            await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                doraMetricsConfig,
            );

        return doraMetrics;
    }

    private async getFormatedColumns(
        organizationId: string,
    ): Promise<ColumnsForMetricsMessage> {
        const columns = await this.projectManagementService.getColumnsConfig({
            organizationId,
        });

        const wipColumn = columns?.allColumns?.find(
            (column) => column.column === 'wip' && Number(column.order) === 1,
        );

        const todoColumn = columns?.allColumns?.find(
            (column) => column.column === 'todo',
        );

        const doneColumn = columns?.allColumns?.find(
            (column) => column.column === 'done',
        );

        return {
            todo: todoColumn?.name,
            wip: wipColumn?.name,
            done: doneColumn?.name,
        };
    }
}
