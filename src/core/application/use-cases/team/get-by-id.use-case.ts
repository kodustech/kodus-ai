import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { ITeam } from '@/core/domain/team/interfaces/team.interface';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';

export class GetByIdUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    public async execute(teamId: string): Promise<Partial<ITeam>> {
        try {
            const team = await this.teamService.findOne({
                uuid: teamId,
            });

            return team?.toJson();
        } catch (error) {
            throw error;
        }
    }
}
