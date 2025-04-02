import { Inject, Injectable } from '@nestjs/common';
import {
    TEAM_MEMBERS_REPOSITORY_TOKEN,
    ITeamMemberRepository,
} from '@/core/domain/teamMembers/contracts/teamMembers.repository.contracts';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { KodyNotification } from '@/core/domain/platformIntegrations/types/communication/kodyNotification.type';
import { TeamMemberEntity } from '@/core/domain/teamMembers/entities/teamMember.entity';
import {
    ITeamRepository,
    TEAM_REPOSITORY_TOKEN,
} from '@/core/domain/team/contracts/team.repository.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class SendKodyNotificationToTeamMemberUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_REPOSITORY_TOKEN)
        private readonly teamMemberRepository: ITeamMemberRepository,

        @Inject(TEAM_REPOSITORY_TOKEN)
        private readonly teamsRepository: ITeamRepository,

        private readonly communicationService: CommunicationService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(members: string[], notification: KodyNotification) {
        try {
            const teamMembers =
                await this.teamMemberRepository.findManyById(members);

            if (!teamMembers) {
                throw new Error('Team member not found');
            }

            const completeTeamMembers =
                await this.addOrganizationToTeamMembers(teamMembers);

            await this.sendNotificationOnDm(completeTeamMembers, notification);

            return 'ok';
        } catch (error) {
            this.logger.error({
                message: 'Error sending Kody notification',
                context: SendKodyNotificationToTeamMemberUseCase.name,
                serviceName: 'SendKodyNotificationToTeamMemberUseCase',
                error: error,
                metadata: {
                    members,
                    notification,
                },
            });
        }
    }

    private async sendNotificationOnDm(
        teamMembers: TeamMemberEntity[],
        notification: KodyNotification,
    ) {
        await Promise.all(
            teamMembers.map(async (teamMember) => {
                if (!teamMember?.communicationId) {
                    return;
                }

                await this.communicationService.newTextMessage({
                    organizationAndTeamData: {
                        teamId: teamMember?.team?.uuid,
                        organizationId: teamMember?.team?.organization?.uuid,
                    },
                    channelId: teamMember?.communicationId,
                    message:
                        await this.communicationService.formatKodyNotification({
                            organizationAndTeamData: {
                                teamId: teamMember?.team?.uuid,
                                organizationId:
                                    teamMember?.team?.organization?.uuid,
                            },
                            notification,
                        }),
                    dmNotification: true,
                });
            }),
        );
    }

    private async addOrganizationToTeamMembers(
        teamMembers: TeamMemberEntity[],
    ): Promise<TeamMemberEntity[]> {
        try {
            const uniqueTeamIds = Array.from(
                new Set(teamMembers.map((member) => member.team.uuid)),
            );

            const completeTeams =
                await this.teamsRepository.findManyByIds(uniqueTeamIds);

            const teamOrganizationMap = new Map();
            for (const team of completeTeams) {
                teamOrganizationMap.set(team.uuid, team.organization);
            }

            for (const member of teamMembers) {
                if (member.team && teamOrganizationMap.has(member.team.uuid)) {
                    member.team.organization = teamOrganizationMap.get(
                        member.team.uuid,
                    );
                }
            }

            return teamMembers;
        } catch (error) {
            throw new Error(
                `Error adding organization to team members: ${error.message}`,
            );
        }
    }
}
