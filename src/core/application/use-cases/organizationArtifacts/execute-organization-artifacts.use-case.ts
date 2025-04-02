import {
    IOrganizationArtifactsService,
    ORGANIZATION_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.service.contracts';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ExecuteOrganizationArtifactsUseCase {
    constructor(
        @Inject(ORGANIZATION_ARTIFACTS_SERVICE_TOKEN)
        private organizationArtifactsService: IOrganizationArtifactsService,
    ) {}

    async execute(params: {
        organizationId: string;
        type: string;
        artifactsToolType?: ArtifactsToolType;
    }) {
        if (params.type === 'weekly') {
            return await this.organizationArtifactsService.executeWeekly(
                {
                    organizationId: params.organizationId,
                },
                params.artifactsToolType,
            );
        }

        return await this.organizationArtifactsService.executeDaily({
            organizationId: params.organizationId,
        });
    }
}
