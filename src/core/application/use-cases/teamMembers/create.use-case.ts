import { Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { IMembers } from '@/core/domain/teamMembers/interfaces/team-members.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { Request } from 'express';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

export class CreateOrUpdateTeamMembersUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}
    public async execute(teamId: string, members: IMembers[]): Promise<any> {
        try {
            return this.teamMembersService.updateOrCreateMembers(members, {
                organizationId: this.request.user.organization.uuid,
                teamId,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error while creating team members',
                context: CreateOrUpdateTeamMembersUseCase.name,
                serviceName: 'GetOrganizationMetricsByIdUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
        }
    }
}
