import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';

@Injectable()
export class ListTeamsUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                uuid: string;
                organization: { uuid: string };
                role: string;
            };
        },
    ) {}

    public async execute() {
        const { user } = this.request;
        const userId = user.uuid;
        const role = user.role;
        const organizationId = user.organization.uuid;
        const status = [STATUS.ACTIVE, STATUS.PENDING];
        const options = {
            order: {
                createdAt: 'ASC',
            },
        };

        if (role === UserRole.OWNER) {
            const teams = await this.teamService.find(
                {
                    organization: { uuid: organizationId },
                },
                status,
                options,
            );

            return teams.map((team) => team.toJson());
        }

        const teams = await this.teamService.getTeamsByUserId(
            userId,
            organizationId,
            status,
            options,
        );

        return teams.map((team) => team.toJson());
    }
}
