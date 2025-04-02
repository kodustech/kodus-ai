import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';

import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import {
    BadRequestException,
    Inject,
    Injectable,
    forwardRef,
} from '@nestjs/common';

import { AxiosDiscordService } from '@/config/axios/microservices/discord.axios';
import { AuthIntegrationEntity } from '@/core/domain/authIntegrations/entities/auth-integration.entity';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { ICommunicationService } from '@/core/domain/platformIntegrations/interfaces/communication.interface';
import { Channel } from '@/core/domain/platformIntegrations/types/communication/channel.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { v4 as uuidv4 } from 'uuid';
import {
    CHECKIN_HISTORY_SERVICE_TOKEN,
    ICheckinHistoryService,
} from '@/core/domain/checkinHistory/contracts/checkinHistory.service.contracts';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { ProfileConfigKey } from '@/core/domain/profileConfigs/enum/profileConfigKey.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN,
    ICheckinHistoryOrganizationService,
} from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistory.service.contracts';
import NotificationFormatter from '@/core/application/use-cases/platformIntegration/communication/sendNotification/notification.formatter';
import { MetricsFormatterCommunicationPlatform } from './metrics/formatCommunicationPlatform/metrics.formatter';
import { DiscordFormatter } from './metrics/formatCommunicationPlatform/discord.formatter';
import { CommunicationManagementConnectionStatus } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';

@Injectable()
@IntegrationServiceDecorator(PlatformType.DISCORD, 'communication')
export class DiscordService implements ICommunicationService {
    private axiosService: AxiosDiscordService;

    constructor(
        @Inject(forwardRef(() => TEAM_MEMBERS_SERVICE_TOKEN))
        private readonly teamMembersService: ITeamMemberService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(CHECKIN_HISTORY_SERVICE_TOKEN)
        private readonly checkinHistoryService: ICheckinHistoryService,

        @Inject(CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN)
        private readonly checkinHistoryOrganizationService: ICheckinHistoryOrganizationService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: IProfileConfigService,
    ) {
        this.axiosService = new AxiosDiscordService();
    }

    public savePrivateChannel(params: any): Promise<void> {
        console.log(params, params);
        throw new Error('Method not implemented.');
    }

    public async handlerTemplateMessage(params: any): Promise<any> {
        try {
            if (params.organizationId == null) {
                params.organizationId =
                    params.organizationAndTeamData.organizationId;
            }

            const response = await this.axiosService.post(
                '/api/handler-template',
                {
                    params,
                },
            );
            return response?.data;
        } catch (error) {
            console.log(error);
        }
    }

    public async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.DISCORD,
            });

            if (!integration) return;

            return await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.CHANNEL_INFO,
                params.configValue,
                integration?.uuid,
                params.organizationAndTeamData,
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    public updateAuthIntegration(params: any): Promise<any> {
        console.log(params);
        return Promise.resolve();
    }

    public async getChannel(params: any): Promise<Channel[]> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.DISCORD,
                );

            if (integration?.authIntegration?.authDetails?.guildId) {
                const response = await this.axiosService.post(
                    '/api/list-channel',
                    {
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        guildId:
                            integration?.authIntegration?.authDetails?.guildId,
                    },
                );

                const integrationConfig =
                    await this.getIntegrationConfigChannelInfo(
                        params.organizationAndTeamData,
                    );

                return response?.data?.map((channel) => ({
                    id: channel?.id,
                    name: channel?.name,
                    selected:
                        channel?.id ===
                        integrationConfig?.configValue?.channelId,
                    type: PlatformType.DISCORD,
                }));
            }
        } catch (error) {
            throw new Error('Not Loading channel', error);
        }
    }

    public async getListMembers(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.DISCORD,
                );

            if (integration?.authIntegration?.authDetails?.guildId) {
                const response = await this.axiosService.post(
                    '/api/list-members',
                    {
                        organizationId: params.organizationId,
                        guildId:
                            integration?.authIntegration?.authDetails?.guildId,
                    },
                );

                return response?.data;
            }
        } catch (e) {
            return [];
        }
    }

    private async getAuthIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<AuthIntegrationEntity> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.DISCORD,
            });

            return this.authIntegrationService.findById(
                integration?.authIntegration?.uuid,
            );
        } catch (err) {
            return err;
        }
    }

    private async getIntegrationConfigChannelInfo(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.DISCORD,
                status: true,
            });

            if (!integration) return null;

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey: IntegrationConfigKey.CHANNEL_INFO,
                });

            return integrationConfig;
        } catch (err) {
            return err;
        }
    }

    public async getChannelIdLeaderTeam(
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

    public async getUserInfo(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const data = await this.getAuthIntegration(organizationAndTeamData);

        return data?.authDetails?.authToken;
    }

    public async addAccessToken(authData: {
        accesToken: string;
        refreshToken: string;
        guildId: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails: {
                accesToken: authData?.accesToken,
                refreshToken: authData?.refreshToken,
                guildId: authData?.guildId,
            },
            organization: {
                uuid: authData?.organizationAndTeamData?.organizationId,
            },
            team: {
                uuid: authData?.organizationAndTeamData?.teamId,
            },
        });

        const integrationUuid = uuidv4();

        return this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.DISCORD,
            integrationCategory: IntegrationCategory.COMMUNICATION,
            status: true,
            organization: {
                uuid: authData?.organizationAndTeamData?.organizationId,
            },
            team: {
                uuid: authData?.organizationAndTeamData?.teamId,
            },
            authIntegration: { uuid: authIntegration?.uuid },
        });
    }

    public async createAuthIntegration(params: any): Promise<any> {
        try {
            const discordIntegrationObject = params.discordIntegrationObject;

            await this.addAccessToken({
                organizationAndTeamData: params.organizationAndTeamData,
                ...discordIntegrationObject,
            });

            await this.profileConfigService.createOrUpdateConfig(
                ProfileConfigKey.USER_NOTIFICATIONS,
                params.user,
                params.organizationAndTeamData,
            );

            return {
                success: true,
                message: 'Integration created successfully',
            };
        } catch (err) {
            throw new BadRequestException(
                err,
                'Error creating integration with Discord',
            );
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<CommunicationManagementConnectionStatus> {
        if (!params.organizationAndTeamData)
            return {
                platformName: PlatformType.DISCORD,
                isSetupComplete: false,
                hasConnection: false,
            };

        const [discordIntegration, channelInfo] = await Promise.all([
            this.integrationService.findOne({
                organization: {
                    uuid: params?.organizationAndTeamData?.organizationId,
                },
                team: {
                    uuid: params?.organizationAndTeamData?.teamId,
                },
                platform: PlatformType.DISCORD,
                status: true,
            }),
            this.getIntegrationConfigChannelInfo(
                params.organizationAndTeamData,
            ),
        ]);

        return {
            platformName: PlatformType.DISCORD,
            isSetupComplete:
                !!channelInfo?.configValue &&
                !!discordIntegration?.authIntegration?.authDetails?.guildId,
            hasConnection: !!discordIntegration,
            category: IntegrationCategory.COMMUNICATION,
        };
    }

    async sendInsightMessage(params: any): Promise<any> {
        const channelId = await this.getTeamChannelId(
            params.organizationAndTeamData,
        );

        if (channelId) {
            return this.newTextMessage({
                message: params.message,
                organizationAndTeamData: params.organizationAndTeamData,
                channelId: channelId,
            });
        }

        return this.newMessagesToProjectLeader({
            organizationId: params.organizationAndTeamData.organizationId,
            teamId: params.teamId,
            message: params.message,
        });
    }

    public async newMessagesToProjectLeader(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const channels = await this.getChannelIdLeaderTeam({
                organizationId: params.organizationAndTeamData.organizationId,
                teamId: params.organizationAndTeamData.teamId,
            });

            if (!channels)
                return {
                    success: false,
                    message: 'Channel ID not found',
                };

            for (const channel of channels) {
                this.newTextMessage({
                    message: params.message,
                    organizationAndTeamData: params.organizationAndTeamData,
                    channelId: channel.id,
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

    public async newTextMessage(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.DISCORD,
                );

            if (!integration)
                return {
                    success: false,
                    message: 'Integration not found',
                };

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration.uuid },
                    team: { uuid: params.organizationAndTeamData.teamId },
                });

            if (!integrationConfig?.configValue)
                return {
                    success: false,
                    message: 'Integration configuration not found',
                };

            if (integration?.authIntegration?.authDetails?.guildId) {
                await this.axiosService.post('/api/channel-notification', {
                    ...params,
                    guildId: integration?.authIntegration?.authDetails?.guildId,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }

    public async newBlockMessage(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.DISCORD,
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
                    guildId: integration?.authIntegration?.authDetails?.guildId,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }

    public async saveChannelSelected(params: any) {
        const integration =
            await this.integrationService.getFullIntegrationDetails(
                params.organizationAndTeamData,
                PlatformType.DISCORD,
            );

        if (integration?.authIntegration?.authDetails?.guildId) {
            await this.createOrUpdateIntegrationConfig({
                configValue: {
                    channelId: params?.channelSelected?.id,
                    channelKey: params?.channelSelected?.name,
                },
                organizationAndTeamData: params.organizationAndTeamData,
            });
        }
    }

    public async getTeamChannelId(params: any): Promise<any> {
        const discord = await this.getIntegrationConfigChannelInfo(params);

        return discord?.configValue?.channelId ?? null;
    }

    public async saveCheckinHistory(params: any): Promise<any> {
        try {
            const content = params.message?.embeds
                ? params.message?.embeds[0]?.description
                : params.message;

            return await this.checkinHistoryService.create({
                teamId: params.organizationAndTeamData.teamId,
                organizationId: params.organizationAndTeamData.organizationId,
                date: params.date,
                content,
                sectionDataItems: params?.sectionDataItems,
                type: params.type,
                overdueWorkItemsList: params?.overdueWorkItemsList,
            });
        } catch (error) {
            throw new Error('Error in Checkin History Save Execution', error);
        }
    }

    public async saveCheckinHistoryOrganization(params: any): Promise<any> {
        try {
            const content = params.message?.embeds
                ? params.message?.embeds[0]?.description
                : params.message;

            return await this.checkinHistoryOrganizationService.create({
                teamsIds: params.teamsIds,
                organizationId: params.organizationId,
                date: params.date,
                content,
                type: params.type,
            });
        } catch (error) {
            throw new Error('Error in Checkin History Save Execution', error);
        }
    }

    public async formatKodyNotification(params: any): Promise<any> {
        return NotificationFormatter.formatForDiscord(params.notification);
    }

    public async formatMetricsMessage(params: any): Promise<any> {
        let comparedMetrics;
        try {
            comparedMetrics =
                await MetricsFormatterCommunicationPlatform.compareMetrics(
                    params.metrics,
                );
        } catch (error) {
            console.error('Error comparing metrics:', error);
            comparedMetrics = null;
        }

        try {
            return DiscordFormatter.format(
                comparedMetrics,
                params.columns,
                params.language,
            );
        } catch (error) {
            console.error('Error formatting metrics:', error);
            return null;
        }
    }
}
