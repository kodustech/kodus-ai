import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { environment } from '@libs/ee/configs/environment';
import type { ILicenseService } from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';
import {
    evaluateCatalogGate,
    isBetaFeaturesEnabled,
} from '@libs/feature-gate/domain/decision';
import { FEATURE_KEYS } from '@libs/feature-gate/domain/feature-keys';
import { loadSnapshot } from '@libs/feature-gate/infrastructure/feature-snapshot.loader';

const logger = createLogger('CustomAgentsPlan');

/** Why a custom agent did not run, said to the team on the PR or the screen. */
export const CUSTOM_AGENTS_PLAN_REQUIRED =
    'Custom agents are available on the Teams and Enterprise plans. Your saved agents are kept and run again after an upgrade.';

/** Why a custom agent did not run on a self-hosted install with beta off. */
export const CUSTOM_AGENTS_BETA_REQUIRED =
    'Custom agents are a beta feature: a self-hosted install runs them with BETA_FEATURES=true. Your saved agents are kept and run once it is set.';

/**
 * Whether this install runs custom agents at their release stage. A
 * self-hosted install runs a beta feature only with BETA_FEATURES=true
 * (#2425); the stage is read from the catalog, so the answer follows the
 * feature when it leaves beta. On Cloud the plan alone decides: no release
 * flag is read for custom agents there, on the screen or here.
 */
export function isCustomAgentsReleaseAllowed(): boolean {
    if (environment.API_CLOUD_MODE) return true;
    return (
        evaluateCatalogGate({
            entry: loadSnapshot().features[FEATURE_KEYS.customAgents],
            audience: 'self-hosted',
            selfHostedBetaEnabled: isBetaFeaturesEnabled(
                process.env.BETA_FEATURES,
            ),
        }) !== 'deny'
    );
}

/**
 * What keeps custom agents from running for this organization, if anything:
 * the install's release stage first (it costs no call), then the plan.
 */
export async function customAgentsBlockedBy(
    licenseService: ILicenseService | undefined,
    organizationAndTeamData: OrganizationAndTeamData,
    logContext: string,
): Promise<'beta' | 'plan' | null> {
    if (!isCustomAgentsReleaseAllowed()) return 'beta';
    return (await isCustomAgentsPlanAllowed(
        licenseService,
        organizationAndTeamData,
        logContext,
    ))
        ? null
        : 'plan';
}

/**
 * Whether the organization's plan runs custom agents and their skills and
 * docs (#2172): Teams, Enterprise and trial, the same matrix as linked
 * repositories (`isTeamsOrEnterpriseTierAllowed`). Fails closed: no license
 * service, or a license that cannot be read, runs none.
 */
export async function isCustomAgentsPlanAllowed(
    licenseService: ILicenseService | undefined,
    organizationAndTeamData: OrganizationAndTeamData,
    logContext: string,
): Promise<boolean> {
    if (!licenseService) return false;
    try {
        const license = await licenseService.validateOrganizationLicense(
            organizationAndTeamData,
        );
        return isTeamsOrEnterpriseTierAllowed(license);
    } catch (error) {
        logger.warn({
            message: 'customAgents plan check failed — treating as not allowed',
            context: logContext,
            metadata: {
                organizationId: organizationAndTeamData?.organizationId,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        return false;
    }
}
