import { cache } from "react";
import { getBYOK } from "@services/organizationParameters/fetch";
import { getOrganizationName } from "@services/organizations/fetch";
import { getPermissions } from "@services/permissions/fetch";
import { getTeams } from "@services/teams/fetch";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { isFeatureEnabled } from "src/core/utils/posthog-server-side";
import {
    getUsersWithLicense,
    validateOrganizationLicense,
} from "src/features/ee/subscription/_services/billing/fetch";

/**
 * Fetches all data needed for the app layout.
 * Uses React's cache() to deduplicate calls within the same request.
 * All API calls are made in parallel to minimize latency.
 */
export const getLayoutData = cache(
    async (teamId: string, _organizationId: string) => {
        const [
            permissions,
            organizationName,
            organizationLicense,
            usersWithAssignedLicense,
            byokConfig,
            tokenUsagePageFeatureFlag,
            codeReviewDryRunFeatureFlag,
            businessLogicFeatureFlag,
            committableSuggestionsFeatureFlag,
            ssoFeatureFlag,
            cliKeysFeatureFlag,
            kodyRuleSuggestionsFeatureFlag,
            githubEnterpriseServerPatFeatureFlag,
            centralizedConfigParameterFeatureFlag,
        ] = await Promise.all([
            getPermissions().catch(() => ({})),
            getOrganizationName().catch(() => ""),
            validateOrganizationLicense({ teamId }).catch(() => null),
            getUsersWithLicense({ teamId }).catch(() => []),
            getBYOK().catch(() => null),
            isFeatureEnabled({ feature: FEATURE_FLAGS.tokenUsagePage }).catch(
                () => false,
            ),
            isFeatureEnabled({ feature: FEATURE_FLAGS.codeReviewDryRun }).catch(
                () => false,
            ),
            isFeatureEnabled({
                feature: FEATURE_FLAGS.businessLogic,
            }).catch(() => false),
            isFeatureEnabled({
                feature: FEATURE_FLAGS.committableSuggestions,
                identifier: "organization",
            }).catch(() => false),
            isFeatureEnabled({ feature: FEATURE_FLAGS.sso }).catch(() => false),
            isFeatureEnabled({ feature: FEATURE_FLAGS.cliKeys }).catch(
                () => false,
            ),
            isFeatureEnabled({
                feature: FEATURE_FLAGS.kodyRuleSuggestions,
            }).catch(() => false),
            isFeatureEnabled({
                feature: FEATURE_FLAGS.githubEnterpriseServerPat,
            }).catch(() => false),
            isFeatureEnabled({
                feature: FEATURE_FLAGS.centralizedConfigParameter,
            }).catch(() => false),
        ]);

        return {
            permissions,
            organizationName,
            organizationLicense,
            usersWithAssignedLicense,
            byokConfig,
            featureFlags: {
                tokenUsagePage: tokenUsagePageFeatureFlag,
                codeReviewDryRun: codeReviewDryRunFeatureFlag,
                businessLogic: businessLogicFeatureFlag,
                committableSuggestions: committableSuggestionsFeatureFlag,
                sso: ssoFeatureFlag,
                cliKeys: cliKeysFeatureFlag,
                kodyRuleSuggestions: kodyRuleSuggestionsFeatureFlag,
                githubEnterpriseServerPat: githubEnterpriseServerPatFeatureFlag,
                centralizedConfigParameter:
                    centralizedConfigParameterFeatureFlag,
            },
        };
    },
);

/**
 * Fetches teams with request-level caching.
 * Uses React's cache() to deduplicate calls within the same request.
 */
export const getTeamsCached = cache(async () => {
    return getTeams().catch(() => []);
});
