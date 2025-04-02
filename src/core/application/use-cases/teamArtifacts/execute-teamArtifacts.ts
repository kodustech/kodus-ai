import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ExecuteTeamArtifactsUseCase {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private teamArtifactsService: ITeamArtifactsService,
    ) {}

    async execute(params: {
        teamId: string;
        organizationId: string;
        type: string;
        artifactsToolType?: ArtifactsToolType;
    }) {
        if (params.type === 'weekly') {
            return await this.teamArtifactsService.executeWeekly(
                {
                    teamId: params.teamId,
                    organizationId: params.organizationId,
                },
                params.artifactsToolType,
            );
        }

        return await this.teamArtifactsService.executeDaily({
            teamId: params.teamId,
            organizationId: params.organizationId,
        });
    }
}
