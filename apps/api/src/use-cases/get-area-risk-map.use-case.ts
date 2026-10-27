import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    CODE_AREA_RISK_MAP_SERVICE_TOKEN,
    ICodeAreaRiskMapService,
    IRefreshCodeAreaRiskMapService,
    REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN,
} from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';
import { rankCodeAreas } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';

@Injectable()
export class GetAreaRiskMapUseCase {
    constructor(
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly access: IConditionalApprovalAccessService,
        @Inject(CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly maps: ICodeAreaRiskMapService,
        @Inject(REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN)
        private readonly refresh: IRefreshCodeAreaRiskMapService,
    ) {}

    async execute(params: {
        organizationId: string;
        teamId: string;
        repositoryId: string;
    }) {
        const { organizationId, teamId, repositoryId } = params;
        if (!(await this.access.isEnabled({ organizationId, teamId }))) {
            throw new ForbiddenException('Code-area history is unavailable');
        }
        const [map, sync] = await Promise.all([
            this.maps.read(organizationId, repositoryId),
            this.refresh.readStatus(organizationId, repositoryId),
        ]);
        const rankedAreas = map ? rankCodeAreas(map.directDirectories) : [];
        return {
            map,
            sync,
            rankedAreaPaths: rankedAreas.map((area) => area.path),
            topAreas: map
                ? rankedAreas.slice(
                      0,
                      Math.ceil(map.directDirectories.length * 0.2),
                  )
                : [],
        };
    }
}
