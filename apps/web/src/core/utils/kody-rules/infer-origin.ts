// Display label for a rule's origin. Each label is the badge text, except
// "manual" which hides the badge.
export type InferredRuleOrigin =
    | "Auto-sync"
    | "Agent file"
    | "Onboarding"
    | "Kody-generated"
    | "Library"
    | "MCP/Agent"
    | "CLI"
    | "manual";

// Keep the key names the badge uses verbatim as the classifier output so the
// two never drift. Each key IS the badge label (except "manual" which hides).

// Mirrors the two lists in libs/common/utils/kody-rules/file-patterns.ts as
// small regex lists, so it works standalone in the browser bundle without
// pulling in picomatch. Case-insensitive (`i`) to mirror the backend's
// discovery/recognition matching (isFileMatchingGlobCaseInsensitive).

// Files written for coding agents. Rules imported from them before they
// stopped converting are frozen.
const AGENT_INSTRUCTION_SOURCE_PATTERNS: RegExp[] = [
    /(?:^|\/)\.cursorrules$/i,
    /(?:^|\/)\.cursor\/rules\//i,
    /(?:^|\/)\.github\/copilot-instructions\.md$/i,
    /(?:^|\/)\.github\/instructions\//i,
    /(?:^|\/)AGENTS\.md$/i,
    /(?:^|\/)\.agents?\.md$/i,
    /(?:^|\/)\.agents\/rules\//i,
    /(?:^|\/)CLAUDE\.md$/i,
    /(?:^|\/)\.claude\//i,
    /(?:^|\/)\.windsurfrules$/i,
    /(?:^|\/)\.sourcegraph\//i,
    /(?:^|\/)\.opencode\.json$/i,
    /(?:^|\/)\.aider\.conf\.yml$/i,
    /(?:^|\/)\.aiderignore$/i,
];

// Kody rule template files: one file = one rule, kept in sync.
const KODY_RULE_SOURCE_PATTERNS: RegExp[] = [
    /(?:^|\/)\.rules\//i,
    /(?:^|\/)\.kody\/rules\//i,
    /(?:^|\/)docs\/coding-standards\//i,
    /(?:^|\/)rules\/.+\.md$/i,
];

export function isAgentInstructionSource(
    sourcePath: string | null | undefined,
): boolean {
    if (!sourcePath) return false;
    return AGENT_INSTRUCTION_SOURCE_PATTERNS.some((pattern) =>
        pattern.test(sourcePath),
    );
}

/** Any file the repo sync has ever imported (agent files included). */
export function isIdeRuleSource(
    sourcePath: string | null | undefined,
): boolean {
    if (!sourcePath) return false;
    return (
        isAgentInstructionSource(sourcePath) ||
        KODY_RULE_SOURCE_PATTERNS.some((pattern) => pattern.test(sourcePath))
    );
}

export function inferRuleOrigin(rule: {
    sourcePath?: string | null;
    origin?: string | null;
}): InferredRuleOrigin {
    switch (rule?.origin) {
        case "repo_file_sync":
            return isAgentInstructionSource(rule.sourcePath)
                ? "Agent file"
                : "Auto-sync";
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
    if (isAgentInstructionSource(rule.sourcePath)) return "Agent file";
    if (isIdeRuleSource(rule.sourcePath)) return "Auto-sync";
    return "Onboarding";
}
