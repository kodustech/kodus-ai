import { Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
    IMembers,
    ITeamMember,
} from '@/core/domain/teamMembers/interfaces/team-members.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

export class GetTeamMemberByRelationsUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}

    public async execute(
        teamId: any,
    ): Promise<{ uuid: string; members: IMembers[] }> {
        try {
            const teamMembers =
                await this.teamMembersService.findManyByRelations({
                    organizationId: this.request.user?.organization?.uuid,
                    teamId,
                });

            if (!teamMembers || teamMembers?.length === 0) {
                return { uuid: '', members: [] };
            }

            return {
                uuid: teamMembers[0].team.uuid,
                members: teamMembers.map((member) => ({
                    uuid: member.uuid,
                    active: member.status,
                    communicationId: member.communicationId,
                    teamRole: member.teamRole,
                    avatar: member.avatar,
                    name: member.name,
                    communication: member.communication,
                    codeManagement: member.codeManagement,
                    projectManagement: member.projectManagement,
                    userId: member.user.uuid,
                    email: member.user.email,
                })),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error while fetching team members',
                context: GetTeamMemberByRelationsUseCase.name,
                serviceName: 'GetTeamMemberByRelationsUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
        }
    }
}
