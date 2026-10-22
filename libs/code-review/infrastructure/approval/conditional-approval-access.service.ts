import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { FeatureGateService, FEATURE_KEYS } from '@libs/feature-gate';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';
import { IConditionalApprovalAccessService } from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

@Injectable()
export class ConditionalApprovalAccessService implements IConditionalApprovalAccessService {
    private readonly logger = createLogger(
        ConditionalApprovalAccessService.name,
    );

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    async isEnabled(org: OrganizationAndTeamData): Promise<boolean> {
        if (!org?.organizationId || !org?.teamId) return false;
        try {
            const releaseTrack = await this.organizationService.getReleaseTrack(
                org.organizationId,
            );
            const betaEnabled = await this.featureGate.isEnabled(
                FEATURE_KEYS.conditionalPrApproval,
                {
                    identifier: org.organizationId,
                    organizationAndTeamData: org,
                    releaseTrack,
                },
            );
            if (!betaEnabled) return false;
            const license =
                await this.licenseService.validateOrganizationLicense(org);
            return isTeamsOrEnterpriseTierAllowed(license);
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not resolve conditional approval access; treating it as off',
                context: ConditionalApprovalAccessService.name,
                error,
                metadata: { organizationId: org.organizationId },
            });
            return false;
        }
    }
}
