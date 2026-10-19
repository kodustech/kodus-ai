/**
 * Web feature flag inventory. Mirrors the runtime keys handled by
 * libs/feature-gate. Only flags that are actively gated on the web side
 * belong here. Stale flags (token-usage-page, code-review-dry-run, etc.)
 * are removed from code along with their gates; new flags must have a
 * matching `release/features.yaml` entry.
 */
export const FEATURE_FLAGS = {
    githubEnterpriseServerPat: "github-enterprise-server-pat",
    /** "Kodus as a provider" (prepaid credits) — private alpha. Gates the
     *  discovery copy only; the API hides the provider itself. */
    kodusProvider: "kodus-provider",
    /** Deterministic evidence (CI checks + scanners) — beta. Gates the
     *  settings section; the pipeline gates the feature itself and fails
     *  closed, so without this the toggles save but nothing would run. */
    deterministicEvidence: "deterministic-evidence",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];
