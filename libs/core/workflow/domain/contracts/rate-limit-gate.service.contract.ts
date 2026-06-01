import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

export const RATE_LIMIT_GATE_SERVICE_TOKEN = Symbol.for(
    'RateLimitGateService',
);

/**
 * Pre-check gate that asks the SCM API "do I have budget?" before the
 * processor starts the expensive work. Cheap to call (the /rate_limit
 * endpoint itself does not consume quota on GitHub).
 *
 * Implementations are expected to:
 *   - cache results briefly (adaptive TTL — shorter when budget is low)
 *   - throw RateLimitError when `remaining < threshold`
 *   - throw NO error on transport failure (graceful: assume bucket OK so
 *     a broken /rate_limit endpoint does not stop all processing)
 */
export interface IRateLimitGateService {
    /**
     * Checks the installation rate-limit for the given org. If the bucket
     * is below the configured threshold, throws RateLimitError carrying
     * the bucket's `resetAt`. Otherwise resolves silently.
     */
    check(
        organizationAndTeamData: OrganizationAndTeamData,
        platformType: PlatformType,
    ): Promise<void>;
}
