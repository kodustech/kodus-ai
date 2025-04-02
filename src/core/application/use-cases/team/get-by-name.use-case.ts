import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { ITeam } from '@/core/domain/team/interfaces/team.interface';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class GetByNameUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    public async execute(
        teamName: string,
        organizationId: string,
    ): Promise<Partial<ITeam>> {
        try {
            return this.teamService.findOne({
                name: teamName,
                organization: {
                    uuid: organizationId,
                },
            });
        } catch (error) {
            throw error;
        }
    }
}
