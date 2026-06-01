import { ConflictException, Inject, Injectable } from '@nestjs/common';

import { CreateOrUpdateParametersUseCase } from '../parameters/create-or-update-use-case';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { TeamEntity } from '@libs/organization/domain/team/entities/team.entity';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    KodyLearningStatus,
    PlatformConfigValue,
} from '@libs/organization/domain/parameters/types/configValue.type';
import { ParametersKey } from '@libs/core/domain/enums';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

@Injectable()
export class CreateTeamUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly telemetry: TelemetryService,
    ) {}

    public async execute(payload: {
        teamName: string;
        organizationId: string;
        organizationName?: string;
        actorUserId?: string;
    }): Promise<TeamEntity | undefined> {
        const orgId = payload.organizationId;

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
            throw new ConflictException('api.team.team_name_already_exists');
        }

        const team = await this.teamService.createTeam({
            ...payload,
            organizationId: orgId,
        });

        if (team && team?.uuid) {
            this.savePlatormConfigsParameters(orgId, team.uuid);
        }

        if (team?.uuid) {
            void this.telemetry.teamCreated({
                teamId: team.uuid,
                name: team.name,
                organizationId: team.organization?.uuid ?? orgId,
                organizationName:
                    team.organization?.name ?? payload.organizationName,
                actorUserId: payload.actorUserId,
            });
        }

        return team;
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
