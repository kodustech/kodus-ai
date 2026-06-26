// Display label for a rule's origin. Each label is the badge text, except
// "manual" which hides the badge.
export type InferredRuleOrigin =
    | "Auto-sync"
    | "Onboarding"
    | "Kody-generated"
    | "Library"
    | "MCP/Agent"
    | "CLI"
    | "manual";

// Keep the key names the badge uses verbatim as the classifier output so the
// two never drift. Each key IS the badge label (except "manual" which hides).

// Recognises the file-path shapes that can ONLY come from the IDE-rule sync
// flow (i.e. the list in libs/common/utils/kody-rules/file-patterns.ts).
// Kept as a small regex list so it works standalone in the browser bundle
// without pulling in picomatch.
const IDE_RULE_SOURCE_PATTERNS: RegExp[] = [
    /(?:^|\/)\.cursorrules$/,
    /(?:^|\/)\.cursor\/rules\//,
    /(?:^|\/)\.github\/copilot-instructions\.md$/,
    /(?:^|\/)\.github\/instructions\//,
    /(?:^|\/)\.agents?\.md$/,
    /(?:^|\/)CLAUDE\.md$/,
    /(?:^|\/)\.claude\//,
    /(?:^|\/)\.windsurfrules$/,
    /(?:^|\/)\.sourcegraph\//,
    /(?:^|\/)\.opencode\.json$/,
    /(?:^|\/)\.aider\.conf\.yml$/,
    /(?:^|\/)\.aiderignore$/,
    /(?:^|\/)\.rules\//,
    /(?:^|\/)\.kody\/rules\//,
    /(?:^|\/)docs\/coding-standards\//,
];

export function isIdeRuleSource(
    sourcePath: string | null | undefined,
): boolean {
    if (!sourcePath) return false;
    return IDE_RULE_SOURCE_PATTERNS.some((pattern) => pattern.test(sourcePath));
}

export function inferRuleOrigin(rule: {
    sourcePath?: string | null;
    origin?: string | null;
}): InferredRuleOrigin {
    switch (rule?.origin) {
        case "repo_file_sync":
            return "Auto-sync";
        case "onboarding_repo_analysis":
            return "Onboarding";
        case "past_reviews":
            return "Kody-generated";
        case "library":
            return "Library";
        case "mcp_agent":
            return "MCP/Agent";
        case "cli":
            return "CLI";
        case "manual":
            return "manual";
    }

    // Fallback for rows still on the legacy origin set.
    if (rule?.origin === "generated") return "Kody-generated";
    if (!rule?.sourcePath) return "manual";
    if (isIdeRuleSource(rule.sourcePath)) return "Auto-sync";
    return "Onboarding";
}
