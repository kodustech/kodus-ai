import { isKodyRuntimeReleasedToTrack } from "@libs/feature-gate/domain/kody-runtime-release";
import type { ReleaseTrack } from "@libs/feature-gate/domain/release-track";
import { getOrganizationReleaseTrack } from "@services/organizations/release-track";

/**
 * Whether Kody Runtime is released to the signed-in org: its stored release
 * track is `alpha`, in cloud and self-hosted alike, with no flag service —
 * the same predicate the API gate asks, so the UI and the API agree. Decides
 * the nav entries, the /runtime routes, the repository's Runtime settings and
 * the PR list column. A track that cannot be read is a no.
 */
export const isKodyRuntimeReleased = async (
    releaseTrack?: Promise<ReleaseTrack>,
): Promise<boolean> => {
    try {
        return isKodyRuntimeReleasedToTrack(
            await (releaseTrack ?? getOrganizationReleaseTrack()),
        );
    } catch {
        return false;
    }
};
