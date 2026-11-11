import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { parseAlphaOrgs } from '@libs/core/infrastructure/services/providers/kodus-provider-gate.service';
import { FEATURE_KEYS, FeatureGateService } from '@libs/feature-gate';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

/** Env allow-list for the alpha: `*` or comma-separated organization ids. */
export const DEEP_SCAN_ALPHA_ORGS_ENV = 'API_DEEP_SCAN_ALPHA_ORGS';

export const DEEP_SCAN_NOT_ENABLED_MESSAGE =
    'Deep scan is in private alpha and is not enabled for this organization.';

/**
 * Release gate for the deep scan (private alpha, cloud only).
 *
 * The `deep-scan` catalog entry is at stage `alpha`: an organization needs
 * the alpha release track AND the PostHog flag's release conditions, where
 * the alpha list lives. The env allow-list opens it on dev VMs and e2e
 * (`*`), and is unset in production. Fails closed.
 */
@Injectable()
export class DeepScanGate {
    private readonly logger = createLogger(DeepScanGate.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    async isEnabledFor(organizationId: string | undefined): Promise<boolean> {
        if (!organizationId) {
            return false;
        }
        const allow = parseAlphaOrgs(process.env[DEEP_SCAN_ALPHA_ORGS_ENV]);
        if (allow === '*' || allow.has(organizationId)) {
            return true;
        }
        try {
            const releaseTrack =
                await this.organizationService.getReleaseTrack(organizationId);
            return await this.featureGate.isEnabled(FEATURE_KEYS.deepScan, {
                identifier: organizationId,
                organizationAndTeamData: { organizationId },
                releaseTrack,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not resolve the deep scan gate; treating it as off',
                context: DeepScanGate.name,
                error,
                metadata: { organizationId },
            });
            return false;
        }
    }
}
