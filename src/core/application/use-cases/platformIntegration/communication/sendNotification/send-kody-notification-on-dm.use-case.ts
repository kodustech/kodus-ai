import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_REPOSITORY_TOKEN,
    ITeamRepository,
} from '@/core/domain/team/contracts/team.repository.contract';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { KodyNotification } from '@/core/domain/platformIntegrations/types/communication/kodyNotification.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TeamMemberEntity } from '@/core/domain/teamMembers/entities/teamMember.entity';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberService } from '@/core/infrastructure/adapters/services/teamMembers.service';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class SendKodyNotificationOnDmUseCase {
    constructor(
        @Inject(TEAM_REPOSITORY_TOKEN)
        private readonly teamRepository: ITeamRepository,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: TeamMemberService,

        private readonly communicationService: CommunicationService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        notification: KodyNotification,
    ) {
        try {
            let teamMembers: TeamMemberEntity[] = [];
            if (organizationAndTeamData?.organizationId) {
                teamMembers = await this.getUsersByOrganizationId(
                    organizationAndTeamData.organizationId,
                );

                await Promise.all(
                    teamMembers.map(async (teamMember) => {
                        await this.sendNotificationOnDms(
                            {
                                organizationId:
                                    organizationAndTeamData?.organizationId,
                                teamId: teamMember?.team?.uuid,
                            },
                            [teamMember],
                            notification,
                        );
                    }),
                );
            } else if (organizationAndTeamData?.teamId) {
                const team = await this.teamRepository.findOne({
                    uuid: organizationAndTeamData.teamId,
                });

                teamMembers = await this.getUsersByTeamId(
                    organizationAndTeamData.teamId,
                );

                await this.sendNotificationOnDms(
                    {
                        organizationId: team?.organization?.uuid,
                        teamId: team?.uuid,
                    },
                    teamMembers,
                    notification,
                );
            } else {
                throw new Error(
                    'Unable to identify users for sending messages!',
                );
            }

            return 'OK';
        } catch (error) {
            this.logger.error({
                message: 'Error sending Kody notification',
                context: SendKodyNotificationOnDmUseCase.name,
                serviceName: 'SendKodyNotificationOnDmUseCase',
                error: error,
                metadata: {
                    organizationAndTeamData,
                    notification,
                },
            });
        }
    }

    private async sendNotificationOnDms(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembers: TeamMemberEntity[],
        notification: KodyNotification,
    ) {
        await Promise.all(
            teamMembers.map(async (teamMember) => {
                await this.communicationService.newTextMessage({
                    organizationAndTeamData,
                    channelId: teamMember.communicationId,
                    message:
                        await this.communicationService.formatKodyNotification({
                            organizationAndTeamData,
                            notification,
                        }),
                    dmNotification: true,
                });
            }),
        );
    }

    private async getUsersByOrganizationId(organizationId: string) {
        const teamMembers =
            await this.teamMembersService.findManyByOrganizationId(
                organizationId,
                [STATUS.ACTIVE],
            );

        return Array.from(
            new Map(
                teamMembers
                    .filter((member) => member.status === true)
                    .map((member) => [member.user.uuid, member]),
            ).values(),
        );
    }

    private async getUsersByTeamId(teamId: string) {
        const teamMembers = await this.teamMembersService.findManyByRelations({
            teamId,
        });
        return Array.from(
            new Map(
                teamMembers
                    .filter((member) => member.status === true)
                    .map((member) => [member.user.uuid, member]),
            ).values(),
        );
    }
}
