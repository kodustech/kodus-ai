import { evaluateCatalogGate } from "@libs/feature-gate/domain/decision";
import { FEATURE_KEYS } from "@libs/feature-gate/domain/feature-keys";
import type { ReleaseTrack } from "@libs/feature-gate/domain/release-track";
import { PostHog } from "posthog-node";
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
 * `libs/feature-gate/domain/decision.ts`. Self-hosted uses BETA_FEATURES;
 * cloud beta uses the org's release track; other cloud stages use PostHog.
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
        const selfHosted = process.env.WEB_NODE_ENV === "self-hosted";
        const releaseTrackBeta = feature === FEATURE_KEYS.conditionalPrApproval;
        const decision = evaluateCatalogGate({
            entry,
            audience: selfHosted ? "self-hosted" : "cloud",
            track:
                entry?.stage === "beta" && !releaseTrackBeta
                    ? "beta"
                    : releaseTrack,
            selfHostedBetaEnabled:
                releaseTrackBeta || entry?.stage !== "beta"
                    ? process.env.BETA_FEATURES === "true"
                    : true,
        });

        if (decision === "deny") return false;
        if (selfHosted) return true;
        if (entry?.stage === "beta" && releaseTrackBeta) return true;

        // Keep the existing cloud behavior when PostHog is unconfigured.
        const posthog = getPostHog();
        if (!posthog) return true;

        const jwtPayload = await auth();
        const orgId = jwtPayload?.user?.organizationId;
        const id = identifier === "user" ? jwtPayload?.user?.userId : orgId;
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
