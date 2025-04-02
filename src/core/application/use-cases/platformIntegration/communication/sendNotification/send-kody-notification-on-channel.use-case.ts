import { STATUS } from '@/config/types/database/status.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { Channel } from '@/core/domain/platformIntegrations/types/communication/channel.type';
import { KodyNotification } from '@/core/domain/platformIntegrations/types/communication/kodyNotification.type';
import {
    TEAM_REPOSITORY_TOKEN,
    ITeamRepository,
} from '@/core/domain/team/contracts/team.repository.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SendKodyNotificationOnChannelUseCase {
    constructor(
        @Inject(TEAM_REPOSITORY_TOKEN)
        private readonly teamRepository: ITeamRepository,

        private readonly communicationService: CommunicationService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        notification: KodyNotification,
    ) {
        let channelsInfo: Channel[] = [];

        try {
            if (organizationAndTeamData?.organizationId) {
                channelsInfo = await this.getTeamChannelsByOrganization(
                    organizationAndTeamData.organizationId,
                );
            } else if (organizationAndTeamData?.teamId) {
                const channel = await this.getChannelByTeamId(
                    organizationAndTeamData.teamId,
                );
                organizationAndTeamData.organizationId = channel.organizationId;
                channelsInfo = channel.channelsInfo;
            } else {
                throw new Error('Unable to identify the channel');
            }

            await this.sendNotificationOnChannels(
                organizationAndTeamData,
                notification,
                channelsInfo,
            );

            return 'ok';
        } catch (error) {
            this.logger.error({
                message: 'Error sending Kody notification',
                context: SendKodyNotificationOnChannelUseCase.name,
                serviceName: 'SendKodyNotificationOnChannelUseCase',
                error: error,
                metadata: {
                    organizationAndTeamData,
                    notification,
                },
            });
        }
    }
    private async sendNotificationOnChannels(
        organizationAndTeamData: OrganizationAndTeamData,
        notification: KodyNotification,
        channels: Channel[],
    ) {
        await Promise.all(
            channels.map(async (channel) => {
                const notificationMessage =
                    await this.communicationService.formatKodyNotification(
                        { organizationAndTeamData, notification },
                        channel.type,
                    );

                await this.communicationService.newBlockMessage(
                    {
                        organizationAndTeamData,
                        channelId: channel.id,
                        blocks: notificationMessage,
                    },
                    channel?.type,
                );
            }),
        );
    }

    private async getTeamChannelsByOrganization(organizationId: string) {
        const teams = await this.teamRepository.find(
            {
                organization: {
                    uuid: organizationId,
                },
            },
            [STATUS.ACTIVE],
        );

        const channelsInfo = await Promise.all(
            teams.map(async (team) => {
                return this.communicationService.getChannel({
                    organizationAndTeamData: {
                        organizationId,
                        teamId: team.uuid,
                    },
                });
            }),
        );

        return channelsInfo.flat().filter((channel) => channel.selected);
    }

    private async getChannelByTeamId(teamId: string) {
        const team = await this.teamRepository.find(
            {
                uuid: teamId,
            },
            [STATUS.ACTIVE],
        );

        const channelId = await this.communicationService.getTeamChannelId({
            organizationId: team[0]?.organization?.uuid,
            teamId,
        });

        const channelsInfo = await this.communicationService.getChannel({
            organizationAndTeamData: {
                organizationId: team[0]?.organization?.uuid,
                teamId,
            },
            channelId,
        });

        return {
            channelsInfo: channelsInfo
                .flat()
                .filter((channel) => channel.id === channelId),
            organizationId: team[0]?.organization?.uuid,
        };
    }
}
