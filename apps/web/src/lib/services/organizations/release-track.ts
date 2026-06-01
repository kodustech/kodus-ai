import { cache } from "react";
import { authorizedFetch } from "@services/fetch";

import {
    DEFAULT_RELEASE_TRACK,
    type ReleaseTrack,
} from "@libs/feature-gate/domain/release-track";
import { pathToApiUrl } from "src/core/utils/helpers";

/**
 * Server-side fetch of the authenticated org's release track. Wrapped in
 * React `cache` so multiple flag checks per request collapse to a single
 * network call. Falls back to the safe default if the endpoint is missing
 * (e.g. older API revs without the Fase 2 migration).
 */
export const getOrganizationReleaseTrack = cache(
    async (): Promise<ReleaseTrack> => {
        try {
            const result = await authorizedFetch<{
                releaseTrack: ReleaseTrack;
            }>(pathToApiUrl("/organization/release-track"));
            return result?.releaseTrack ?? DEFAULT_RELEASE_TRACK;
        } catch {
            return DEFAULT_RELEASE_TRACK;
        }
    },
);
