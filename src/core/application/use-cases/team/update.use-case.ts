import { STATUS } from '@/config/types/database/status.type';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { ConflictException, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class UpdateTeamUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}
    public async execute(payload: {
        teamName: string;
        teamId: string;
    }): Promise<void> {
        const validStatuses = Object.values(STATUS).filter(
            (status) => status !== STATUS.REMOVED,
        );

        const hasTeams = await this.teamService.find(
            {
                name: payload.teamName,
                organization: { uuid: this.request.user.organization.uuid },
            },
            [...validStatuses],
        );

        const hasTeam = hasTeams?.find((team) => team.uuid !== payload.teamId);
        if (!hasTeam && hasTeams?.length === 1) {
            return;
        }
        if (hasTeam) {
            throw new ConflictException('api.team.team_name_already_exists');
        }

        await this.teamService.update(
            {
                uuid: payload.teamId,
                organization: { uuid: this.request.user.organization.uuid },
            },
            {
                organization: { uuid: this.request.user.organization.uuid },
                name: payload.teamName,
            },
        );
    }
}
