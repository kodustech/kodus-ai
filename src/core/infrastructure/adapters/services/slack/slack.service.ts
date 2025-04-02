import { AxiosSlackService } from '@/config/axios/microservices/slack.axios';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import NotificationFormatter from '@/core/application/use-cases/platformIntegration/communication/sendNotification/notification.formatter';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { AuthIntegrationEntity } from '@/core/domain/authIntegrations/entities/auth-integration.entity';
import { BotInfo } from '@/core/domain/authIntegrations/types/slack-auth-detail.type';
import {
    CHECKIN_HISTORY_SERVICE_TOKEN,
    ICheckinHistoryService,
} from '@/core/domain/checkinHistory/contracts/checkinHistory.service.contracts';
import {
    CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN,
    ICheckinHistoryOrganizationService,
} from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistory.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { ICommunicationService } from '@/core/domain/platformIntegrations/interfaces/communication.interface';
import { Channel } from '@/core/domain/platformIntegrations/types/communication/channel.type';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@/core/domain/profile/contracts/profile.service.contract';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { ProfileConfigKey } from '@/core/domain/profileConfigs/enum/profileConfigKey.enum';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import {
    BadRequestException,
    Inject,
    Injectable,
    forwardRef,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsFormatterCommunicationPlatform } from '../metrics/formatCommunicationPlatform/metrics.formatter';
import { SlackFormatter } from '../metrics/formatCommunicationPlatform/slack.formatter';
import { CommunicationManagementConnectionStatus } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';

@Injectable()
@IntegrationServiceDecorator(PlatformType.SLACK, 'communication')
export class SlackService implements ICommunicationService {
    private axiosService: AxiosSlackService;

    constructor(
        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,

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
        this.axiosService = new AxiosSlackService();
    }

    async saveCheckinHistoryOrganization(params: any): Promise<any> {
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
            console.error('Error when saving checkin execution:', error);
            throw new Error(
                `Error when saving checkin execution: ${error.message}`,
            );
        }
    }

    async saveCheckinHistory(params: any): Promise<any> {
        try {
            const content = params.message?.embeds
                ? params.message?.embeds[0]?.description
                : params.message;

            return await this.checkinHistoryService.create({
                organizationId: params.organizationAndTeamData.organizationId,
                teamId: params.organizationAndTeamData.teamId,
                date: params.date,
                content:
                    content && content.length > 0
                        ? JSON.stringify(content)
                        : '',
                sectionDataItems: params?.sectionDataItems,
                type: params.type,
                overdueWorkItemsList: params?.overdueWorkItemsList,
            });
        } catch (error) {
            throw new Error('Error in Checkin History Save Execution', error);
        }
    }

    async saveChannelSelected(params: any): Promise<any> {
        try {
            let configValue: {
                channelId: string;
                channelKey: string;
                isPrivateAndButtonDisabled?: boolean;
                isConfirmed?: boolean;
            } = {
                channelId: params?.channelSelected?.id,
                channelKey: params?.channelSelected?.name,
            };

            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.SLACK,
                );

            if (integration?.authIntegration?.authDetails?.slackTeamId) {
                if (params.isPrivate) {
                    const { data: botAddedToChannel } =
                        await this.axiosService.post(
                            '/api/check-bot-in-channel',
                            {
                                organizationAndTeamData:
                                    params.organizationAndTeamData,
                                channelId: params.channelSelected.id,
                                botUserId:
                                    integration?.authIntegration?.authDetails
                                        ?.botInfo?.botUserId,
                            },
                        );

                    if (!botAddedToChannel) {
                        return false;
                    }
                }

                if (!params.isPrivate) {
                    await this.axiosService.post('/api/enter-channel', {
                        organizationAndTeamData: params.organizationAndTeamData,
                        channelSelected: params.channelSelected,
                    });
                }

                await this.createOrUpdateIntegrationConfig({
                    configValue,
                    organizationAndTeamData: params.organizationAndTeamData,
                });

                return true;
            }
        } catch (error) {
            console.log(error);
        }
    }

    async handlerTemplateMessage(params: any): Promise<any> {
        try {
            if (!params?.organizationAndTeamData?.organizationId) {
                return;
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

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.SLACK,
            });

            if (!integration) {
                return;
            }

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

    updateAuthIntegration(params: any): Promise<any> {
        console.log(params);
        return Promise.resolve();
    }

    async getChannel(params: any): Promise<Channel[]> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.SLACK,
                );

            if (integration?.authIntegration?.authDetails?.slackTeamId) {
                const response = await this.axiosService.post(
                    '/api/list-channel',
                    {
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                );

                const integrationConfig =
                    await this.getIntegrationConfigChannelInfo(
                        params?.organizationAndTeamData,
                    );

                return response?.data?.map((channel: Channel) => {
                    let channelFormatted: any = {
                        id: channel?.id,
                        name: channel?.name,
                        selected:
                            channel?.id ===
                            integrationConfig?.configValue?.channelId,
                        isPrivate: channel?.isPrivate,
                        type: PlatformType.SLACK,
                    };

                    if (
                        channel?.isPrivate &&
                        channel?.id ===
                            integrationConfig?.configValue?.channelId
                    ) {
                        channelFormatted.isConfirmed =
                            integrationConfig?.configValue?.isConfirmed;
                    }

                    return channelFormatted;
                });
            }
        } catch (error) {
            throw new Error('Not Loading channel', error);
        }
    }

    async getListMembers(params: any): Promise<any> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.SLACK,
                );

            if (integration?.authIntegration?.authDetails?.slackTeamId) {
                const response = await this.axiosService.post(
                    '/api/list-members',
                    {
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                );

                return response?.data.map((member) => {
                    return {
                        realName: member.profile?.real_name,
                        communicationId: member.id,
                        name: member.profile?.real_name,
                        avatar: member.profile?.image_original,
                    };
                });
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
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
                platform: PlatformType.SLACK,
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
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
                platform: PlatformType.SLACK,
            });

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integration?.uuid },
                    configKey: IntegrationConfigKey.CHANNEL_INFO,
                    team: { uuid: organizationAndTeamData.teamId },
                });

            return integrationConfig;
        } catch (err) {
            return err;
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
        } catch (error) {
            console.error("Error when retrieving leader's channel id ", error);
            return [];
        }
    }

    async getUserInfo(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const data = await this.getAuthIntegration(organizationAndTeamData);

        return data?.authDetails?.authToken;
    }

    async addAccessToken(slackData: {
        accessTokenUser: string;
        accessTokenBot: string;
        slackTeamId: string;
        organizationAndTeamData: OrganizationAndTeamData;
        botInfo?: BotInfo;
    }): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails: {
                authToken: slackData?.accessTokenUser,
                botToken: slackData?.accessTokenBot,
                slackTeamId: slackData?.slackTeamId,
                botInfo: slackData?.botInfo,
            },
            organization: {
                uuid: slackData.organizationAndTeamData.organizationId,
            },
            team: { uuid: slackData.organizationAndTeamData.teamId },
        });

        const integrationUuid = uuidv4();

        return this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.SLACK,
            integrationCategory: IntegrationCategory.COMMUNICATION,
            status: true,
            organization: {
                uuid: slackData.organizationAndTeamData.organizationId,
            },
            team: { uuid: slackData.organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegration?.uuid },
        });
    }

    public async createAuthIntegration(params: any): Promise<any> {
        try {
            const slackIntegrationObject = params.slackIntegrationObject;

            await this.addAccessToken({
                organizationAndTeamData: params.organizationAndTeamData,
                ...slackIntegrationObject,
                slackTeamId: slackIntegrationObject.teamId,
                botInfo: slackIntegrationObject?.botInfo,
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
                'Error creating integration with Slack',
            );
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<CommunicationManagementConnectionStatus> {
        if (!params.organizationAndTeamData)
            return {
                platformName: PlatformType.SLACK,
                isSetupComplete: false,
                hasConnection: false,
            };

        const [slackIntegration, channelInfo] = await Promise.all([
            this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: params.organizationAndTeamData.teamId,
                },
                platform: PlatformType.SLACK,
                status: true,
            }),
            this.getIntegrationConfigChannelInfo(
                params.organizationAndTeamData,
            ),
        ]);

        const isSetupComplete =
            channelInfo?.configValue &&
            channelInfo.configValue.hasOwnProperty('isConfirmed')
                ? channelInfo?.configValue.isConfirmed
                : !!channelInfo?.configValue;

        return {
            platformName: PlatformType.SLACK,
            isSetupComplete:
                isSetupComplete &&
                !!slackIntegration?.authIntegration?.authDetails?.slackTeamId,
            hasConnection: !!slackIntegration,
            category: IntegrationCategory.COMMUNICATION,
        };
    }

    async newMessagesToProjectLeader(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const channels = await this.getChannelIdLeaderTeam(params);

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

    async newTextMessage(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            let message = '';
            let success = false;

            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.SLACK,
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

            if (params?.dmNotification) {
                if (integration?.authIntegration?.authDetails?.slackTeamId) {
                    const response = await this.axiosService.post(
                        '/api/send-block-message',
                        {
                            ...params,
                            blocks: params.message,
                        },
                    );

                    if (response?.data?.success) {
                        success = response?.data?.success;
                        message = response?.data?.message;
                    }

                    return { success, message };
                }
            }

            if (integration?.authIntegration?.authDetails?.slackTeamId) {
                const response = (await this.axiosService.post(
                    '/api/channel-notification',
                    {
                        ...params,
                    },
                )) as any;

                if (response?.data?.success) {
                    success = response?.data?.success;
                    message = response?.data?.message;
                }
            }

            return { success, message };
        } catch (error) {
            console.log(error);
        }
    }

    async newBlockMessage(
        params: any,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const integration =
                await this.integrationService.getFullIntegrationDetails(
                    params.organizationAndTeamData,
                    PlatformType.SLACK,
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

            if (integrationConfig) {
                await this.axiosService.post('/api/send-block-message', {
                    ...params,
                });
            }
        } catch (error) {
            console.log(error);
        }
    }

    async saveSlackChannelSelected(params: any) {
        const integration =
            await this.integrationService.getFullIntegrationDetails(
                params.organizationAndTeamData,
                PlatformType.SLACK,
            );

        if (integration?.authIntegration?.authDetails?.slackTeamId) {
            await this.axiosService.post('/api/enter-channel', {
                organizationAndTeamData: params.organizationAndTeamData,
                channelSelected: params.channelSelected,
            });

            await this.createOrUpdateIntegrationConfig({
                configValue: {
                    channelId: params?.channelSelected?.id,
                    channelKey: params?.channelSelected?.name,
                },
                organizationAndTeamData: params.organizationAndTeamData,
            });
        }
    }

    async findOneByOrganizationId(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const slack = await this.getIntegrationConfigChannelInfo(
            organizationAndTeamData,
        );

        return slack?.configValue;
    }

    async getTeamChannelId(params: any): Promise<any> {
        const slack = await this.getIntegrationConfigChannelInfo(params);

        return slack?.configValue?.channelId ?? null;
    }

    async sendInsightMessage(params: any): Promise<any> {
        const channelId = await this.getTeamChannelId(
            params.organizationAndTeamData,
        );

        if (channelId) {
            return this.newTextMessage({
                message: params.message,
                organizationAndTeamData: {
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                    teamId: params.organizationAndTeamData.teamId,
                },
                channelId: channelId,
            });
        }

        return this.newMessagesToProjectLeader({
            organizationAndTeamData: params.organizationAndTeamData,
            message: params.message,
        });
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

    async formatKodyNotification(params: any): Promise<any> {
        return NotificationFormatter.formatForSlack(params.notification);
    }

    async formatMetricsMessage(params: any): Promise<any> {
        const comparedMetrics =
            await MetricsFormatterCommunicationPlatform.compareMetrics(
                params.metrics,
            );

        return SlackFormatter.format(comparedMetrics, params.columns);
    }
}
