import { cache } from "react";
import { getLLMConfigStatus } from "@services/organizationParameters/fetch";
import { getOrganizationName } from "@services/organizations/fetch";
import { getOrganizationReleaseTrack } from "@services/organizations/release-track";
import { getPermissions } from "@services/permissions/fetch";
import { getTeams } from "@services/teams/fetch";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { isFeatureEnabled } from "src/core/feature-gate/resolver";
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
        const releaseTrackPromise = getOrganizationReleaseTrack();

        const [
            permissions,
            organizationName,
            organizationLicense,
            usersWithAssignedLicense,
            llmConfigStatus,
            githubEnterpriseServerPatFeatureFlag,
        ] = await Promise.all([
            getPermissions().catch(() => ({})),
            getOrganizationName().catch(() => ""),
            validateOrganizationLicense({ teamId }).catch(() => null),
            getUsersWithLicense({ teamId }).catch(() => []),
            getLLMConfigStatus().catch(() => null),
            releaseTrackPromise
                .then((releaseTrack) =>
                    isFeatureEnabled({
                        feature: FEATURE_FLAGS.githubEnterpriseServerPat,
                        releaseTrack,
                    }),
                )
                .catch(() => false),
        ]);

        return {
            permissions,
            organizationName,
            organizationLicense,
            usersWithAssignedLicense,
            llmConfigStatus,
            featureFlags: {
                githubEnterpriseServerPat: githubEnterpriseServerPatFeatureFlag,
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
