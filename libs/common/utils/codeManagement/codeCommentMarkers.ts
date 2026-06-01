const KODY_CODE_REVIEW_COMPLETED_MARKER = '## Code Review Completed! 🔥';
const KODY_CODE_REVIEW_COMPLETED_MARKER_ENCODED =
    '## Code Review Completed! ud83dudd25'; // Azure encoded emoji
const KODY_CRITICAL_ISSUE_COMMENT_MARKER = '# Found critical issues please';
const KODY_START_COMMAND_MARKER = '@kody start';

export {
    KODY_CODE_REVIEW_COMPLETED_MARKER,
    KODY_CRITICAL_ISSUE_COMMENT_MARKER,
    KODY_START_COMMAND_MARKER,
};

const EXACT_MARKERS = [
    KODY_CODE_REVIEW_COMPLETED_MARKER,
    KODY_CODE_REVIEW_COMPLETED_MARKER_ENCODED,
    KODY_CRITICAL_ISSUE_COMMENT_MARKER,
] as const;

/**
 * Pattern-based markers to exclude (supports variations)
 * Each pattern can match multiple variations of the same command
 */
const PATTERN_MARKERS = [
    /@?kody\s+(start(-review)?|review)\b|start-review/i,
] as const;

/**
 * Check if a comment contains any Kody marker (exact match or pattern)
 */
export const hasKodyMarker = (text: string | undefined | null): boolean => {
    if (!text) return false;

    const hasExactMatch = EXACT_MARKERS.some((marker) => text.includes(marker));
    if (hasExactMatch) return true;

    const hasPatternMatch = PATTERN_MARKERS.some((pattern) =>
        pattern.test(text),
    );

    return hasPatternMatch;
};

/**
 * Patterns for webhook comment command detection
 * Uses (?=\s|$) lookahead to ensure command ends with whitespace or end of string
 * This prevents matching "review-code" as a review command
 */
export const KODY_REVIEW_COMMAND_PATTERN =
    /^\s*@kody\s+(start-review|review)(?=\s|$)/i;
export const KODY_REVIEW_MARKER_PATTERN = /<!--\s*kody-codereview\s*-->/i;
export const KODY_MENTION_NON_REVIEW_PATTERN =
    /^\s*@kody\b(?!\s+(start-review|review)(?=\s|$))/i;

/**
 * Force re-review flag. Customers append `--force` (or `force`) to bypass
 * the "no new commits / already reviewed" guard so they can re-run a review
 * after fixing whatever made the previous run fail (e.g. topping up BYOK
 * credits). Telemetry distinguishes it from the regular command via the
 * `command-force` origin set by each provider's webhook handler.
 */
export const KODY_FORCE_REVIEW_COMMAND_PATTERN =
    /^\s*@kody\s+(start-review|review)\s+--?force\b/i;

/**
 * Check if comment is a review command (@kody start-review or @kody review).
 * Accepts an optional trailing flag like `--force`, so this still returns
 * true for force runs — callers that need to distinguish use
 * isForceReviewCommand().
 */
export const isReviewCommand = (text: string | undefined | null): boolean => {
    if (!text) return false;
    return KODY_REVIEW_COMMAND_PATTERN.test(text);
};

/**
 * Check if the review command carries the force flag (`@kody review --force`).
 * Subset of isReviewCommand — when this returns true, isReviewCommand is
 * already true. Callers use this to decide whether to record telemetry as
 * `command-force` and to bypass the re-review guard.
 */
export const isForceReviewCommand = (
    text: string | undefined | null,
): boolean => {
    if (!text) return false;
    return KODY_FORCE_REVIEW_COMMAND_PATTERN.test(text);
};

/**
 * Check if comment has the kody-codereview HTML marker
 */
export const hasReviewMarker = (text: string | undefined | null): boolean => {
    if (!text) return false;
    return KODY_REVIEW_MARKER_PATTERN.test(text);
};

/**
 * Check if comment mentions @kody but is NOT a review command
 */
export const isKodyMentionNonReview = (
    text: string | undefined | null,
): boolean => {
    if (!text) return false;
    return KODY_MENTION_NON_REVIEW_PATTERN.test(text);
};
