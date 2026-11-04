/**
 * Enterprise Code — see `license_ee.md`. Which plans run heavy mode.
 */
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    type ILicenseService,
    type OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';

const logger = createLogger('HeavyModePlan');

/** Why a review asked for heavy ran Balanced, said to the team. The license
 *  services answer a failed read as an invalid license, so the text holds for
 *  a plan without heavy and for a plan that could not be confirmed. */
export const HEAVY_MODE_PLAN_REQUIRED =
    'Heavy mode is available on the Teams and Enterprise plans, and Kody could not confirm this organization is on one, so this review ran in Balanced mode.';

const isPlan = (plan: string, name: 'teams' | 'enterprise') =>
    plan === name || plan.startsWith(`${name}_`);

/**
 * Heavy mode runs on Teams and Enterprise, in the cloud and self-hosted with a
 * Kodus license key, and on a trial. Free (`free_byok`), self-hosted without a
 * key, and a plan that is not active (expired, canceled, payment failed) run
 * Balanced.
 *
 * Unlike `isTeamsOrEnterpriseTierAllowed`, a self-hosted Teams key runs it.
 */
export function isHeavyModeTierAllowed(
    license: OrganizationLicenseValidationResult | null | undefined,
): boolean {
    if (!license?.valid) return false;
    const rawPlan = license.planType;
    const plan = typeof rawPlan === 'string' ? rawPlan.toLowerCase() : '';
    const paid = isPlan(plan, 'teams') || isPlan(plan, 'enterprise');

    switch (license.subscriptionStatus) {
        case SubscriptionStatus.ACTIVE:
        case SubscriptionStatus.LICENSED_SELF_HOSTED:
            return paid;
        case SubscriptionStatus.TRIAL:
            return true;
        default:
            return false;
    }
}

/**
 * Whether the organization's plan runs heavy mode. Fails closed: no license
 * service, or a license that cannot be read, runs Balanced.
 */
export async function isHeavyModePlanAllowed(
    licenseService: ILicenseService | undefined,
    organizationAndTeamData: OrganizationAndTeamData,
    logContext: string,
): Promise<boolean> {
    if (!licenseService) return false;
    try {
        const license = await licenseService.validateOrganizationLicense(
            organizationAndTeamData,
        );
        return isHeavyModeTierAllowed(license);
    } catch (error) {
        logger.warn({
            message:
                'Could not read the plan for heavy mode; the review runs Balanced',
            context: logContext,
            error,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        });
        return false;
    }
}
