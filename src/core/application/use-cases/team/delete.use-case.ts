import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class DeleteTeamUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(teamId: string): Promise<void> {
        return await this.teamService.deleteOne(teamId);
    }
}
