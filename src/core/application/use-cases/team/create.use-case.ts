import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@/core/domain/team/contracts/team.service.contract';
import { TeamEntity } from '@/core/domain/team/entities/team.entity';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { ConflictException, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { CreateOrUpdateParametersUseCase } from '../parameters/create-or-update-use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    KodyLearningStatus,
    PlatformConfigValue,
} from '@/core/domain/parameters/types/configValue.type';
import { STATUS } from '@/config/types/database/status.type';

export class CreateTeamUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
    ) {}
    public async execute(payload: {
        teamName: string;
        organizationId: string;
    }): Promise<TeamEntity | undefined> {
        try {
            const orgId =
                this.request?.user?.organization?.uuid ||
                payload.organizationId;

            const validStatuses = Object.values(STATUS).filter(
                (status) => status !== STATUS.REMOVED,
            );

            const hasTeams = await this.teamService.find(
                {
                    name: payload.teamName,
                    organization: { uuid: orgId },
                },
                [...validStatuses],
            );

            if (hasTeams?.length) {
                throw new ConflictException(
                    'api.team.team_name_already_exists',
                );
            }

            const team = await this.teamService.createTeam({
                ...payload,
                organizationId: orgId,
            });

            if (team && team?.uuid) {
                this.savePlatormConfigsParameters(orgId, team.uuid);
            }

            return team;
        } catch (error) {
            throw error;
        }
    }

    savePlatormConfigsParameters(organizationId: string, teamId: string) {
        const initialStatus: PlatformConfigValue = {
            finishOnboard: false,
            finishProjectManagementConnection: false,
            kodyLearningStatus: KodyLearningStatus.ENABLED,
        };

        return this.createOrUpdateParametersUseCase.execute(
            ParametersKey.PLATFORM_CONFIGS,
            initialStatus,
            { organizationId, teamId },
        );
    }
}
