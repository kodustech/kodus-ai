import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import type { ILicenseService } from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';

const logger = createLogger('CustomAgentsPlan');

/** Why a custom agent did not run, said to the team on the PR or the screen. */
export const CUSTOM_AGENTS_PLAN_REQUIRED =
    'Custom agents are available on the Teams and Enterprise plans. Your saved agents are kept and run again after an upgrade.';

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
