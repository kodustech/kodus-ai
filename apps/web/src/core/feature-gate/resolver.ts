import { PostHog } from "posthog-node";

import { evaluateCatalogGate } from "@libs/feature-gate/domain/decision";
import type { ReleaseTrack } from "@libs/feature-gate/domain/release-track";

import { auth } from "src/core/config/auth";

import { findFeature } from "./snapshot";

export interface IsFeatureEnabledOptions {
    feature: string;
    identifier?: "user" | "organization";
    /**
     * The org's release track. When omitted, callers should pass the
     * value from `getOrganizationReleaseTrack()` so the stage gate is
     * enforced. If undefined, the safe default `beta` is used (legacy
     * permissive behavior).
     */
    releaseTrack?: ReleaseTrack;
}

/**
 * Process-wide PostHog client. The previous implementation built and
 * shut down a fresh client on every `isFeatureEnabled` call, which:
 *
 *   1. Forced a synchronous network roundtrip per check because the
 *      local flag-evaluation cache never had time to warm up.
 *   2. Defeated `posthog-node`'s background polling for flag definitions.
 *
 * One singleton per Node process gives the SDK a long-lived cache and
 * lets `isFeatureEnabled` resolve in microseconds for known flags. We
 * never call `shutdown()` — we don't capture events from this resolver,
 * only flag reads, so there's nothing pending to flush on process exit.
 */
let posthogSingleton: PostHog | null = null;
function getPostHog(): PostHog | null {
    const apiKey = process.env.WEB_POSTHOG_KEY;
    if (!apiKey) return null;
    if (!posthogSingleton) {
        posthogSingleton = new PostHog(apiKey, {
            host: "https://us.i.posthog.com",
        });
    }
    return posthogSingleton;
}

/**
 * Next.js adapter around the pure `evaluateCatalogGate` decision in
 * `libs/feature-gate/domain/decision.ts`. Web is always cloud, so the
 * audience is hardcoded; runtime specifics are next-auth + posthog-node
 * per call.
 *
 * The lib mirror at `libs/feature-gate/application/feature-gate.service.ts`
 * calls the same `evaluateCatalogGate` — there's exactly one source of
 * gate logic.
 */
export const isFeatureEnabled = async ({
    feature,
    identifier = "user",
    releaseTrack,
}: IsFeatureEnabledOptions): Promise<boolean> => {
    try {
        const entry = findFeature(feature);
        const decision = evaluateCatalogGate({
            entry,
            audience: "cloud",
            track: releaseTrack,
        });

        if (decision === "deny") return false;

        // Self-hosted web bundles run without a PostHog key. After the
        // catalog already passed us, fall through to the legacy
        // permissive behavior so the app keeps working.
        const posthog = getPostHog();
        if (!posthog) return true;

        const jwtPayload = await auth();
        const orgId = jwtPayload?.user?.organizationId;
        const id =
            identifier === "user" ? jwtPayload?.user?.userId : orgId;
        if (!id) return false;

        const value = await posthog
            .isFeatureEnabled(feature, id, {
                groups: { organization: orgId || "" },
            })
            .catch(() => false);
        return value === true;
    } catch (error) {
        console.error("Error checking feature flag:", error);
        return false;
    }
};
