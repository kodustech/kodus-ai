/**
 * Single canonical list of feature flag keys recognized by the catalog.
 * Each key here must have a matching entry in `release/features.yaml` and a
 * corresponding feature flag in PostHog (whose conditions decide rollout in
 * cloud). Keep additions in lockstep with the YAML.
 */
export const FEATURE_KEYS = {
    agentReview: 'agent-review',
    githubEnterpriseServerPat: 'github-enterprise-server-pat',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export const ALL_FEATURE_KEYS: readonly FeatureKey[] = Object.freeze(
    Object.values(FEATURE_KEYS),
);

export function isFeatureKey(value: string): value is FeatureKey {
    return (ALL_FEATURE_KEYS as readonly string[]).includes(value);
}
