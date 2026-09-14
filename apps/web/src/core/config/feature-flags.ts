/**
 * Web feature flag inventory. Mirrors the runtime keys handled by
 * libs/feature-gate. Only flags that are actively gated on the web side
 * belong here. Stale flags (token-usage-page, code-review-dry-run, etc.)
 * are removed from code along with their gates; new flags must have a
 * matching `release/features.yaml` entry.
 */
export const FEATURE_FLAGS = {
    githubEnterpriseServerPat: "github-enterprise-server-pat",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];
