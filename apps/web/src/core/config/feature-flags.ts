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
    conditionalPrApproval: "conditional-pr-approval",
    /** Kody Runtime — released by the org's release track (alpha), not a
     *  flag service. Hides its nav, routes, PR list column and settings; the
     *  API answers 404 to the same orgs. */
    kodyRuntime: "kody-runtime",
    /** Deep scan — private alpha. Gates the menu entry, the page and its
     *  routing card; the API refuses the scans themselves. */
    deepScan: "deep-scan",
    /** Ultra review — alpha, by release track. Gates its mode option, its
     *  models row and its command switch; the API refuses it outside. */
    ultraReview: "ultra-review",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

/**
 * Whether a nav entry, palette page or tab behind `flag` is shown: always
 * without a flag, else only when the org's flag (from the app layout) is on.
 * Flags not loaded, or a check that failed, hide it.
 */
export const isReleasedTo = (
    flag: keyof typeof FEATURE_FLAGS | undefined,
    flags: Partial<Record<keyof typeof FEATURE_FLAGS, boolean | undefined>>,
): boolean => !flag || flags[flag] === true;
