/**
 * Single canonical list of feature flag keys recognized by the catalog.
 * Each key here must have a matching entry in `release/features.yaml` and a
 * corresponding feature flag in PostHog (whose conditions decide rollout in
 * cloud). Keep additions in lockstep with the YAML.
 */
export const FEATURE_KEYS = {
    githubEnterpriseServerPat: 'github-enterprise-server-pat',
    kodusTraceReviewContext: 'kodus-trace-review-context',
    kodusProvider: 'kodus-provider',
    deepScan: 'deep-scan',
    deterministicEvidence: 'deterministic-evidence',
    customAgents: 'custom-agents',
    conditionalPrApproval: 'conditional-pr-approval',
    kodyRuntime: 'kody-runtime',
    ultraReview: 'ultra-review',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = Object.freeze(
    Object.values(FEATURE_KEYS),
);

/**
 * Features decided in cloud by the organization's release track alone, with
 * no PostHog flag: the track is the whole rollout.
 */
const RELEASE_TRACK_ONLY_FEATURES: ReadonlySet<string> = new Set([
    FEATURE_KEYS.conditionalPrApproval,
    FEATURE_KEYS.ultraReview,
]);

export function isReleaseTrackOnlyFeature(feature: string): boolean {
    return RELEASE_TRACK_ONLY_FEATURES.has(feature);
}

export function isFeatureKey(value: string): value is FeatureKey {
    return (ALL_FEATURE_KEYS as readonly string[]).includes(value);
}
