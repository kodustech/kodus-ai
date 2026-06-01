/**
 * Classifies a Kody rule's origin for UI display.
 *
 * The backend's `KodyRulesOrigin` enum has only three discrete values
 * (`USER` / `LIBRARY` / `GENERATED`). The web UI wants finer granularity
 * because the `USER` bucket is the umbrella for several import flows
 * that each set distinct `sourcePath` shapes.
 *
 * Rule of inference, in order:
 *
 *   1. `origin === "generated"`      → "Kody-generated"
 *      (LLM-proposed rule from past reviews / comment analysis)
 *
 *   2. `origin === "library"`        → "Library"
 *      (rule added from the Kody library catalog)
 *
 *   3. `origin === "user"` (or unset legacy) — split by `sourcePath`:
 *      a. `!sourcePath`                         → "manual"
 *         Hand-authored in the web UI; the modal never populates
 *         sourcePath, so its absence pins the rule to manual creation.
 *      b. `sourcePath` matches RULE_FILE_PATTERNS → "Auto-sync"
 *         Imported by the IDE-rule sync flow from `.cursorrules`,
 *         `.cursor/rules/**.mdc`, `CLAUDE.md`, `.windsurfrules`, etc.
 *         The importer always writes the filename it read, which by
 *         definition matches one of those patterns.
 *      c. otherwise (sourcePath outside IDE patterns) → "Onboard"
 *         Imported by the onboarding fast-sync, which inspects arbitrary
 *         repo files (package.json, esbuild.config.js, tsconfig.json…).
 *
 * Why this is safe in practice (verified on the backend importers):
 *   - kodyRulesSync.service.ts always sets sourcePath = IDE rule filename
 *   - import-fast-kody-rules.use-case.ts always sets sourcePath = analysed file
 *   - apps/web modal.tsx sends payloads WITHOUT sourcePath
 *   - add-library-kody-rules.use-case.ts and commentAnalysis.service.ts
 *     don't set sourcePath either
 *
 * If a future flow starts populating sourcePath in a different bucket,
 * either give it its own `KodyRulesOrigin` enum member (preferred) or
 * extend this function — don't shoehorn it through.
 */
export type InferredRuleOrigin =
    | "Auto-sync"
    | "Onboard"
    | "Kody-generated"
    | "Library"
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
    // 1. Origins the backend marks explicitly take precedence.
    if (rule?.origin === "generated") return "Kody-generated";
    if (rule?.origin === "library") return "Library";

    // 2. The remaining `origin === "user"` (or unset legacy) bucket is
    //    split by sourcePath shape, per the contract in the docblock above.
    if (!rule?.sourcePath) return "manual";
    if (isIdeRuleSource(rule.sourcePath)) return "Auto-sync";
    return "Onboard";
}
