import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { FeatureGateService, FEATURE_KEYS } from '@libs/feature-gate';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

/**
 * Release gate for the deterministic-evidence feature (beta).
 *
 * Both halves go through here — the CI-evidence read and the analyzer run — so
 * an organization gets the whole feature or none of it. It is the OUTER gate:
 * each half is additionally opted into per repository, the CI read by
 * `deterministicEvidence.ciChecks` and each analyzer by its own mode, both
 * defaulting to off. This one answers "may this organization have the feature
 * at all", never "is it wanted on this repository".
 *
 * Fails CLOSED: if the gate cannot be resolved, the feature stays off. A beta
 * feature silently switching itself on during an outage is the worse failure.
 */
@Injectable()
export class DeterministicEvidenceGate {
    private readonly logger = createLogger(DeterministicEvidenceGate.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    async isEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const organizationId = organizationAndTeamData?.organizationId;
        if (!organizationId) {
            return false;
        }

        try {
            const releaseTrack =
                await this.organizationService.getReleaseTrack(organizationId);

            return await this.featureGate.isEnabled(
                FEATURE_KEYS.deterministicEvidence,
                {
                    identifier: organizationId,
                    organizationAndTeamData,
                    releaseTrack,
                },
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not resolve the deterministic-evidence gate; treating it as off',
                context: DeterministicEvidenceGate.name,
                error,
                metadata: { organizationId },
            });
            return false;
        }
    }
}
