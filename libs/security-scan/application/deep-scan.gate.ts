import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { environment } from '@libs/ee/configs/environment/environment';
import { FEATURE_KEYS, FeatureGateService } from '@libs/feature-gate';
import { isOnAlphaAllowList } from '@libs/feature-gate/domain/alpha-allow-list';
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
        // Cloud only, before the allow-list: a self-hosted install ships no
        // security-scan worker, so a scan it started would never run.
        if (!environment.API_CLOUD_MODE) {
            return false;
        }
        if (
            isOnAlphaAllowList(
                process.env[DEEP_SCAN_ALPHA_ORGS_ENV],
                organizationId,
            )
        ) {
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
