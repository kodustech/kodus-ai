import { minimatch } from "minimatch";

/**
 * Tests whether a rule's `path` glob (or comma-separated globs) matches
 * a single repository-relative file path. Mirrors the matching rule the
 * backend applies in libs/common/utils/glob-utils.ts so the in-page
 * "Test against file" modal stays consistent with what the code review
 * pipeline will actually do.
 *
 * Behavior:
 *   - empty / "**\/*" path → matches every file
 *   - comma-separated globs (e.g. "src/**,test/**") → ANY match wins
 *   - case-insensitive on the file path (filenames vary across platforms)
 *   - returns false when the rule has no path field at all (unusual)
 */
export function ruleMatchesFile(
    rulePath: string | null | undefined,
    filePath: string,
): boolean {
    if (!filePath) return false;
    const trimmed = (rulePath ?? "").trim();
    if (!trimmed) return true;
    // The rule's path can be a single glob or a comma-separated list. The
    // backend treats the list as OR; we replicate that.
    const globs = trimmed
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
    if (globs.length === 0) return true;

    const normalized = filePath.replace(/^\/+/, "");
    return globs.some((glob) =>
        minimatch(normalized, glob, { dot: true, nocase: false }),
    );
}

export type RuleMatchResult<T> = {
    matched: T[];
    unmatched: T[];
};

/**
 * Splits a list of rules into those that would fire on the given file and
 * those that would not, preserving the input order. Generic over the rule
 * shape so callers can pass the full UI rule type without conversion.
 */
export function splitRulesByFileMatch<T extends { path?: string | null }>(
    rules: T[],
    filePath: string,
): RuleMatchResult<T> {
    const matched: T[] = [];
    const unmatched: T[] = [];
    for (const rule of rules) {
        if (ruleMatchesFile(rule.path, filePath)) {
            matched.push(rule);
        } else {
            unmatched.push(rule);
        }
    }
    return { matched, unmatched };
}
