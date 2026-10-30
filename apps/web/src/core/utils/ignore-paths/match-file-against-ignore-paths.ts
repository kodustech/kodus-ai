import picomatch from "picomatch";

/**
 * Mirrors `isFileMatchingGlob` in libs/common/utils/glob-utils.ts so the
 * "Test a file" verdict cannot contradict what the review actually does.
 *
 * The logic is duplicated rather than imported: the web container mounts
 * libs/ at /usr/libs with no node_modules above it, so anything under libs/
 * that pulls a third-party package fails to resolve at build time. The engine
 * and its options are kept identical on purpose — an earlier version reached
 * for minimatch instead, and the two disagreed on `**\/*- [Bb]ackup
 * ([0-9]).rdl`, a pattern we ship by default: minimatch reads `(` as a
 * literal, picomatch as a group. test/unit/web/match-file-against-ignore-
 * paths.spec.ts pins the two implementations together over every shipped
 * default.
 */

// picomatch compilation is expensive and the validator re-runs on every
// keystroke against the full list, so hold on to the compiled matchers.
const MATCHERS = new Map<string, picomatch.Matcher>();

function matcherFor(pattern: string): picomatch.Matcher {
    let matcher = MATCHERS.get(pattern);
    if (matcher) return matcher;

    matcher = picomatch(pattern, { dot: true, nocase: false });
    MATCHERS.set(pattern, matcher);

    return matcher;
}

/** Same normalization the backend applies before matching. */
function normalizeFilename(filename: string): string {
    return (filename || "")
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "");
}

/**
 * Returns the first ignore pattern that would skip `filename`, or undefined
 * when the file survives every pattern.
 */
export function findIgnoreMatch(
    filename: string,
    patterns: string[],
): string | undefined {
    const normalized = normalizeFilename(filename);
    if (!normalized) return undefined;

    return patterns.find((pattern) => matcherFor(pattern)(normalized));
}
