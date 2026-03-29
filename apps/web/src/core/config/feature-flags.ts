export const FEATURE_FLAGS = {
    tokenUsagePage: "token-usage-page",
    kodyRuleSuggestions: "kody-rules-suggestions",
    codeReviewDryRun: "code-review-dry-run",
    businessLogic: "business-logic",
    sso: "sso",
    cliKeys: "cli-keys",
    committableSuggestions: "committable-suggestions",
    githubEnterpriseServerPat: "github-enterprise-server-pat",
    centralizedConfigParameter: "centralized-config-parameter",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];
