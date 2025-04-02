import {
    IOrganizationArtifactsService,
    ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetOrganizationArtifactsUseCase {
    constructor(
        @Inject(ORGANIZATION_ARTIFACTS_SERVICE_TOKEN)
        private organizationArtifactsService: IOrganizationArtifactsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },
    ) {}

    async execute(teamId: string) {
        const userId = this.request.user?.uuid;

        const organizationTeamAndData = {
            organizationId: this.request.user?.organization.uuid,
            teamId,
        };

        return await this.organizationArtifactsService.getVisibleArtifacts(
            organizationTeamAndData,
            userId,
        );
    }
}
