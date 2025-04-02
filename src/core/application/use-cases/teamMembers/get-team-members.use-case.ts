import { Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetTeamMembersUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(teamId: any): Promise<any> {
        return await this.teamMembersService.findTeamMembersFormated(
            {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
            true,
        );
    }
}
