import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class DismissTeamArtifactUseCase {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private teamArtifactsService: ITeamArtifactsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },
    ) {}

    async execute(artifactId: string, teamId: string) {
        const userId = this.request.user?.uuid;

        const organizationTeamAndData = {
            organizationId: this.request.user?.organization.uuid,
            teamId,
        };

        return await this.teamArtifactsService.dismissArtifact(
            artifactId,
            userId,
            organizationTeamAndData,
        );
    }
}
