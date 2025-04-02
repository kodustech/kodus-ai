import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';

export class GetTeamInfosByTenantNameAndTeamNameUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async execute({ teamName, tenantName }) {
        return await this.teamService.findOne({
            name: teamName,
            organization: {
                tenantName: tenantName,
            },
        });
    }
}
