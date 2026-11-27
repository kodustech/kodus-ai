/**
 * Enterprise Code — see `license_ee.md`. Who may use Ultra review while it is
 * in alpha.
 */
import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { FEATURE_KEYS, FeatureGateService } from '@libs/feature-gate';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

/**
 * Ultra review is at stage `alpha` in `release/features.yaml`: only an
 * organization on the alpha release track may run it, configure it or pick
 * its models. The track alone decides (no PostHog flag), and a track that
 * cannot be read closes it.
 */
@Injectable()
export class UltraReviewGate {
    private readonly logger = createLogger(UltraReviewGate.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    async isEnabledFor(organizationId: string | undefined): Promise<boolean> {
        if (!organizationId) return false;
        try {
            const releaseTrack =
                await this.organizationService.getReleaseTrack(organizationId);
            return await this.featureGate.isEnabled(FEATURE_KEYS.ultraReview, {
                identifier: organizationId,
                organizationAndTeamData: { organizationId },
                releaseTrack,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the Ultra review gate; treating it as off',
                context: UltraReviewGate.name,
                error,
                metadata: { organizationId },
            });
            return false;
        }
    }
}
