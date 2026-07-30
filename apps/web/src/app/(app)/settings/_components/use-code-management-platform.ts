import { useSuspenseGetConnections } from "@services/setup/hooks";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PlatformType } from "src/core/types";
import { safeArray } from "src/core/utils/safe-array";

/**
 * Returns the platform type(s) of the active CODE_MANAGEMENT connections
 * for the current team. Returns a Set for O(1) lookups.
 *
 * Called unconditionally in every hook that needs platform info so that
 * React's hook-order invariant is never violated across navigations.
 */
function useCodeManagementPlatforms(): Set<string> {
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);

    return new Set(
        safeArray(connections)
            .filter(
                (c) => c.category === "CODE_MANAGEMENT" && c.hasConnection,
            )
            .map((c) => c.platformName),
    );
}

/**
 * Returns true when the "Request Changes" review-status toggle should be
 * hidden.  Hidden when ALL connected platforms are GitLab (the feature
 * is not supported there).  For mixed-platform teams the setting is
 * shown because it may apply to non-GitLab repositories.
 */
export function useShouldHideRequestChanges(): boolean {
    const platforms = useCodeManagementPlatforms();

    // All connected platforms are GitLab → feature unsupported everywhere.
    return platforms.size > 0 && !platforms.has(PlatformType.GITHUB)
        && !platforms.has(PlatformType.BITBUCKET)
        && !platforms.has(PlatformType.AZURE_REPOS)
        && !platforms.has(PlatformType.FORGEJO);
}

/**
 * Returns true when the "Post as hidden comment" toggle should be hidden.
 * Hidden when NO connected platform is GitHub (the feature is
 * GitHub-only).  For mixed-platform teams the setting is shown because
 * it may apply to GitHub repositories.
 */
export function useShouldHideHiddenComments(): boolean {
    const platforms = useCodeManagementPlatforms();
    return platforms.size > 0 && !platforms.has(PlatformType.GITHUB);
}

/**
 * Returns true when the "Enable LLM Prompt" toggle should be hidden.
 * Hidden when ALL connected platforms are Bitbucket (the feature is not
 * supported there).  For mixed-platform teams the setting is shown
 * because it may apply to non-Bitbucket repositories.
 */
export function useShouldHideLLMPrompt(): boolean {
    const platforms = useCodeManagementPlatforms();

    // All connected platforms are Bitbucket → feature unsupported everywhere.
    return platforms.size > 0 && !platforms.has(PlatformType.GITHUB)
        && !platforms.has(PlatformType.GITLAB)
        && !platforms.has(PlatformType.AZURE_REPOS)
        && !platforms.has(PlatformType.FORGEJO);
}
