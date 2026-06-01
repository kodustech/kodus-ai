import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import type { ReleaseTrack } from '@libs/feature-gate/domain/release-track';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

export class GetReleaseTrackUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(): Promise<{ releaseTrack: ReleaseTrack }> {
        const releaseTrack = await this.organizationService.getReleaseTrack(
            this.request.user.organization.uuid,
        );
        return { releaseTrack };
    }
}
