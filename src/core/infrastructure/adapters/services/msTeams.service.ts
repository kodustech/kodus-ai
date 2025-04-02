import { AxiosMSTeamsService } from '@/config/axios/microservices/msteams.axios';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { MSTeamsInstallationApp } from '@/core/domain/integrationConfigs/types/communication/msTeamsInstalationApp.type';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { IMSTeamsService } from '@/core/domain/msTeams/msTeams.service.contract';
import { ICommunicationService } from '@/core/domain/platformIntegrations/interfaces/communication.interface';
import { Channel } from '@/core/domain/platformIntegrations/types/communication/channel.type';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { CommunicationManagementConnectionStatus } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
@IntegrationServiceDecorator(PlatformType.MSTEAMS, 'communication')
export class MSTeamsService implements IMSTeamsService, ICommunicationService {
    private axiosService: AxiosMSTeamsService;

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(forwardRef(() => TEAM_MEMBERS_SERVICE_TOKEN))
        private readonly teamMembersService: ITeamMemberService,
    ) {
        this.axiosService = new AxiosMSTeamsService();
    }
    formatMetricsMessage(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    formatKodyNotification(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    saveCheckinHistoryOrganization(params: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    saveCheckinHistory(checkinHistory: any): Promise<any> {
        console.log(checkinHistory);
        throw new Error('Method not implemented.');
    }

    savePrivateChannel(params: any): Promise<void> {
        console.log(params, params);
        throw new Error('Method not implemented.');
    }

    saveChannelSelected(params: any): Promise<void> {
        console.log(params, params);
        throw new Error('Method not implemented.');
    }

    async handlerTemplateMessage(params: any): Promise<any> {
        try {
            if (!params.authIntegration) {
                const integration = await this.integrationService.findOne({
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    team: { uuid: params.organizationAndTeamData.teamId },
                    status: true,
                    platform: PlatformType.MSTEAMS,
                });

                if (!integration) return;

                params.authIntegration =
                    integration?.authIntegration?.authDetails;
            }

            const response = await this.axiosService.post(
                '/api/handler-template',
                { params },
            );
            return response?.data;
        } catch (error) {
            console.log(error);
        }
    }

    async createAuthIntegration(params: any): Promise<any> {
        try {
            const authUuid = uuidv4();

            const authIntegration = await this.authIntegrationService.create({
                uuid: authUuid,
                status: true,
                authDetails: {
                    authToken: params.authToken,
                    tenantId: params?.tenantId,
                },
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            return await this.addIntegration(
                params.organizationAndTeamData,
                authIntegration?.uuid,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        try {
            const response = await this.authIntegrationService.findOne({
                authDetails: { ['tenantId']: params.tenantId },
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            const authIntegration = await this.authIntegrationService.update(
                {
                    uuid: response?.uuid,
                },
                {
                    status: true,
                    authDetails: {
                        ...response.authDetails,
                    },
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    team: { uuid: params.organizationAndTeamData.teamId },
                },
            );

            return authIntegration;
        } catch (error) {
            console.log(error);
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integrationId =
                await this.authIntegrationService.getIntegrationUuidByAuthDetails(
                    { ['tenantId']: params.tenantId },
                    PlatformType.MSTEAMS,
                );

            if (integrationId) {
                let saveData: MSTeamsInstallationApp[] = [
                    {
                        serviceUrl: params.serviceUrl,
                        conversationType: params.conversationType,
                        conversationId: params.conversationId,
                        msTeamsUserId: params.msTeamsUserId,
                    },
                ];

                const config =
                    await this.integrationConfigService.findIntegrationConfigFormatted<
                        MSTeamsInstallationApp[]
                    >(
                        IntegrationConfigKey.MSTEAMS_INSTALLATION_APP,
                        params.organizationAndTeamData,
                    );

                if (!config) {
                    return await this.integrationConfigService.createOrUpdateConfig(
                        IntegrationConfigKey.MSTEAMS_INSTALLATION_APP,
                        saveData,
                        integrationId,
                        params.teamId,
                    );
                } else {
                    saveData = [...saveData, ...config];

                    return await this.integrationConfigService.createOrUpdateConfig(
                        IntegrationConfigKey.MSTEAMS_INSTALLATION_APP,
                        saveData,
                        integrationId,
                        params.teamId,
                    );
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    getChannel(params: any): Promise<Channel[]> {
        console.log('getChannel', params);
        return Promise.resolve([]);
    }

    async newBlockMessage(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.MSTEAMS,
                );

            if (!integration)
                return {
                    success: false,
                    message: 'Integration not found',
                };

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration.uuid },
                });

            if (integrationConfig) {
                await this.axiosService.post('/api/send-block-message', {
                    ...params,
                    serviceUrl: integrationConfig?.configValue[0]?.serviceUrl,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }

    async newTextMessage(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.MSTEAMS,
                );

            if (!integration)
                return {
                    success: false,
                    message: 'Integration not found',
                };

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration.uuid },
                });

            if (!integrationConfig?.configValue)
                return {
                    success: false,
                    message: 'Integration configuration not found',
                };

            if (integration?.authIntegration?.authDetails?.tenantId) {
                await this.axiosService.post('/api/channel-notification', {
                    serviceUrl: integrationConfig?.configValue[0]?.serviceUrl,
                    channelId: params.channelId,
                    message: params.message,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }

    async getTeamChannelId(params: any): Promise<any> {
        const integration =
            await this.integrationService.getFullIntegrationDetails(
                params.organizationAndTeamData,
                PlatformType.MSTEAMS,
            );

        if (!integration) return null;

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration.uuid },
        });

        type config = {
            conversationId: string;
            conversationType: string;
        };

        const channel = integrationConfig?.configValue
            ?.reverse()
            .find(
                (config: config) =>
                    config.conversationType === 'personal' ||
                    config.conversationType === 'channel' ||
                    config.conversationType === 'groupChannel',
            );

        return channel?.conversationId ?? null;
    }

    async sendInsightMessage(params: any): Promise<any> {
        const channelId = await this.getTeamChannelId(params);

        if (channelId) {
            return this.sendMessageToMemberID({
                ...params,
                chatId: channelId,
            });
        }

        return this.newMessagesToProjectLeader(params);
    }

    async getListMembers(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.MSTEAMS,
                );

            if (integration?.authIntegration?.authDetails?.tenantId) {
                const response = await this.axiosService.post(
                    '/api/list-members',
                    {
                        tenantId:
                            integration?.authIntegration?.authDetails?.tenantId,
                    },
                );

                return response?.data?.map((member) => {
                    return {
                        realName: member?.displayName,
                        communicationId: member?.id,
                        name: member?.displayName,
                        avatar: null,
                    };
                });
            }

            return [];
        } catch (error) {
            console.log(error);
        }
    }

    async getTeamsStoryUrl() {
        try {
            const response = await this.axiosService.get(
                '/api/teams-story-url',
            );
            return response?.data;
        } catch (error) {
            console.log(error);
        }
    }

    async getChannelIdLeaderTeam(
        params: any,
    ): Promise<{ id: string; name: string }[]> {
        try {
            const leaders = await this.teamMembersService.getLeaderMembers(
                params.organizationAndTeamData,
            );

            if (!leaders) {
                null;
            }

            return leaders?.map((leader) => {
                return {
                    id: leader?.communication?.id,
                    name: leader?.communication?.name,
                };
            });
        } catch (error) {}
    }

    async newMessagesToProjectLeader(params: any): Promise<{
        success: boolean;
        message: string;
    }> {
        try {
            const chats = await this.getChannelIdLeaderTeam(params);

            if (!chats)
                return {
                    success: false,
                    message: 'Chat ID not found',
                };

            for (const chat of chats) {
                this.sendMessageToMemberID({
                    ...params,
                    chatId: chat.id,
                });
            }

            return {
                success: true,
                message: `Message ${params.message} sent successfully!`,
            };
        } catch (e) {
            return {
                success: false,
                message: 'Error sending message: ' + e,
            };
        }
    }

    async sendMessageToMemberID(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.MSTEAMS,
                );

            if (!integration)
                return {
                    success: false,
                    message: 'Integration not found',
                };

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration.uuid },
                });

            if (!integrationConfig?.configValue)
                return {
                    success: false,
                    message: 'Integration configuration not found',
                };

            if (integration?.authIntegration?.authDetails?.tenantId) {
                const response = await this.axiosService.post(
                    '/api/channel-notification',
                    {
                        tenantId:
                            integration?.authIntegration?.authDetails?.tenantId,
                        serviceUrl:
                            integrationConfig?.configValue[0]?.serviceUrl,
                        channelId: params.chatId,
                        message: params.message,
                    },
                );

                return response;
            }

            return 'Not Send message';
        } catch (error) {
            console.log(error);
        }
    }

    async installBotInTeamMembers(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.MSTEAMS,
                );

            const membersWithInstall = [];

            if (
                integration &&
                integration?.authIntegration?.authDetails?.tenantId
            ) {
                for await (const member of params.members) {
                    const response = await this.axiosService.post(
                        '/api/install-bot-members',
                        {
                            memberId: member.id,
                            tenantId:
                                integration?.authIntegration?.authDetails
                                    ?.tenantId,
                        },
                    );

                    if (response?.data?.id) {
                        membersWithInstall?.push({
                            userId: member.id,
                            chatId: response?.data?.id,
                        });
                    }
                }
            }

            return membersWithInstall;
        } catch (error) {
            console.log(error);
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<CommunicationManagementConnectionStatus> {
        const integration =
            await this.integrationService.getFullIntegrationDetails(
                params.organizationAndTeamData,
                PlatformType.MSTEAMS,
            );

        if (!integration)
            return {
                isSetupComplete: false,
                hasConnection: false,
                platformName: PlatformType.MSTEAMS,
            };

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration.uuid },
        });

        const isSetupComplete =
            integration?.authIntegration?.authDetails?.tenantId &&
            integrationConfig?.configValue?.length > 0;

        return {
            isSetupComplete,
            hasConnection: !!integration,
            platformName: PlatformType.MSTEAMS,
            category: IntegrationCategory.COMMUNICATION,
        };
    }

    async addIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        authIntegrationId: string,
    ): Promise<IntegrationEntity> {
        try {
            const integrationUuid = uuidv4();

            return await this.integrationService.create({
                uuid: integrationUuid,
                platform: PlatformType.MSTEAMS,
                integrationCategory: IntegrationCategory.COMMUNICATION,
                status: true,
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                authIntegration: { uuid: authIntegrationId },
            });
        } catch (error) {
            console.log(error);
        }
    }

    async constructResponseCommunicationBlock(params: {
        deliveryForecastingBlock;
        needsAttentionBlock;
        flowEffiencyBlock;
    }) {
        return {
            blocks: [
                ...params.deliveryForecastingBlock,
                ...params.needsAttentionBlock,
                ...params.flowEffiencyBlock,
            ],
        };
    }
}
