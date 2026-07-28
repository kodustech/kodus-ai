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

/** Default bot username used when no custom username is configured */
const DEFAULT_BOT_USERNAME = 'kody';

/**
 * Escape special regex characters in a string to use it in a RegExp literal.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * Heavy-mode flag. Customers append `--heavy` to a review command to run EXTRA
 * resample passes in the finder — higher recall (finds more), at the cost of
 * more candidates/noise. Opt-in per review. Can be combined with a focus
 * directive and/or `--force` in any order (`@kody review --heavy --force`).
 *
 * A dash is required (like `--force`): a bare `heavy` is treated as directive
 * text, not the flag, to avoid mis-firing on focus phrases (e.g.
 * `@kody review heavy checkout path`).
 */
export const KODY_HEAVY_REVIEW_COMMAND_PATTERN =
    /^\s*@kody\s+(?:start-review|review)\b[ \t]+(?:[^\n]*\s)?--?heavy\b/i;

/**
 * Build a review command regex for a given bot username.
 * Falls back to DEFAULT_BOT_USERNAME when botUsername is empty/undefined.
 */
function buildReviewCommandPattern(
    botUsername?: string | null,
): RegExp {
    const name = escapeRegex(botUsername || DEFAULT_BOT_USERNAME);
    return new RegExp(
        `^\\s*@${name}\\s+(start-review|review)(?=\\s|$)`,
        'i',
    );
}

/**
 * Build a force-review command regex for a given bot username.
 */
function buildForceReviewCommandPattern(
    botUsername?: string | null,
): RegExp {
    const name = escapeRegex(botUsername || DEFAULT_BOT_USERNAME);
    return new RegExp(
        `^\\s*@${name}\\s+(start-review|review)\\s+--?force\\b`,
        'i',
    );
}

/**
 * Build a heavy-review command regex for a given bot username.
 */
function buildHeavyReviewCommandPattern(
    botUsername?: string | null,
): RegExp {
    const name = escapeRegex(botUsername || DEFAULT_BOT_USERNAME);
    return new RegExp(
        `^\\s*@${name}\\s+(?:start-review|review)\\b[ \\t]+(?:[^\\n]*\\s)?--?heavy\\b`,
        'i',
    );
}

/**
 * Build a review command head regex for a given bot username.
 */
function buildReviewCommandHeadPattern(
    botUsername?: string | null,
): RegExp {
    const name = escapeRegex(botUsername || DEFAULT_BOT_USERNAME);
    return new RegExp(
        `^\\s*@${name}\\s+(?:start-review|review)\\b[ \\t]*(?:(?:--?force|--?heavy)\\b[ \\t]*)*`,
        'i',
    );
}

/**
 * Build a non-review mention regex for a given bot username.
 */
function buildMentionNonReviewPattern(
    botUsername?: string | null,
): RegExp {
    const name = escapeRegex(botUsername || DEFAULT_BOT_USERNAME);
    return new RegExp(
        `^\\s*@${name}\\b(?!\\s+(start-review|review)(?=\\s|$))`,
        'i',
    );
}

/**
 * Check if the review command carries the heavy flag (`@kody review --heavy`).
 * Subset of isReviewCommand. Callers set `heavy: true` on the review context so
 * the finder runs the extra critic pass.
 */
export const isHeavyReviewCommand = (
    text: string | undefined | null,
    botUsername?: string | null,
): boolean => {
    if (!text) return false;
    if (KODY_HEAVY_REVIEW_COMMAND_PATTERN.test(text)) return true;
    if (botUsername && buildHeavyReviewCommandPattern(botUsername).test(text))
        return true;
    return false;
};

/**
 * Check if comment is a review command (@kody start-review or @kody review).
 * Accepts an optional trailing flag like `--force`, so this still returns
 * true for force runs — callers that need to distinguish use
 * isForceReviewCommand().
 *
 * @param botUsername Optional custom bot username. When provided, also matches
 *                   `@<botUsername> review` in addition to `@kody review`.
 */
export const isReviewCommand = (
    text: string | undefined | null,
    botUsername?: string | null,
): boolean => {
    if (!text) return false;
    if (KODY_REVIEW_COMMAND_PATTERN.test(text)) return true;
    if (botUsername && buildReviewCommandPattern(botUsername).test(text))
        return true;
    return false;
};

/**
 * Check if the review command carries the force flag (`@kody review --force`).
 * Subset of isReviewCommand — when this returns true, isReviewCommand is
 * already true. Callers use this to decide whether to record telemetry as
 * `command-force` and to bypass the re-review guard.
 */
export const isForceReviewCommand = (
    text: string | undefined | null,
    botUsername?: string | null,
): boolean => {
    if (!text) return false;
    if (KODY_FORCE_REVIEW_COMMAND_PATTERN.test(text)) return true;
    if (botUsername && buildForceReviewCommandPattern(botUsername).test(text))
        return true;
    return false;
};

/**
 * Captures the command head (`@kody review` / `@kody start-review`) plus an
 * optional `--force` flag, so the remaining text on the command can be read as
 * a free-text steering directive (e.g. `@kody review focus on the auth logic`).
 */
const KODY_REVIEW_COMMAND_HEAD_PATTERN =
    /^\s*@kody\s+(?:start-review|review)\b[ \t]*(?:(?:--?force|--?heavy)\b[ \t]*)*/i;

/** Hard cap so a pasted wall of text can't blow up the prompt. */
const MAX_REVIEW_DIRECTIVE_LENGTH = 500;

/**
 * The directive is UNTRUSTED text (anyone who can comment can supply it) and it
 * gets rendered inside a `<ReviewFocus>` block in the finder prompt. Strip the
 * characters it could use to break out of that block — primarily the angle
 * brackets that could forge a `</ReviewFocus>` close tag or a fake `<section>` —
 * plus control characters, and collapse whitespace. This is structural
 * defense-in-depth, not a full prompt-injection defense: the directive is also
 * framed as a low-trust hint that only prioritizes (never suppresses/approves)
 * and is injected ONLY into the finder prompt, not the verify/summary passes.
 * Backticks and ordinary punctuation are kept so a legit focus like
 * "the `topCodes` sort" survives.
 */
const sanitizeReviewDirective = (raw: string): string =>
    raw
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Sanitize + length-cap an already-extracted directive string. Shared by the
 * PR-comment path (parseReviewDirective) and the CLI path (`--focus`), so every
 * surface that feeds a steering directive into the finder applies the same
 * structural prompt-injection hardening. Returns undefined when empty.
 */
export const normalizeReviewDirective = (
    raw: string | undefined | null,
): string | undefined => {
    if (!raw) return undefined;
    const clean = sanitizeReviewDirective(String(raw)).slice(
        0,
        MAX_REVIEW_DIRECTIVE_LENGTH,
    );
    return clean || undefined;
};

/**
 * Extract the free-text steering directive a user appended to a review command
 * (`@kody review <directive>`). Returns the sanitized directive, or undefined
 * when the comment is not a review command or carries no extra text (the common
 * `@kody review` / `@kody review --force` case). Only the first line after the
 * command is used; the `--force` flag and surrounding quotes are stripped; the
 * text is sanitized (see sanitizeReviewDirective) and length-capped. Steers what
 * the finder focuses on; it never filters — clear issues elsewhere are still
 * reported.
 */
export const parseReviewDirective = (
    text: string | undefined | null,
    botUsername?: string | null,
): string | undefined => {
    if (!text) return undefined;
    if (!isReviewCommand(text, botUsername)) return undefined;

    // Try the hardcoded @kody pattern first, then the custom bot pattern
    const head =
        text.match(KODY_REVIEW_COMMAND_HEAD_PATTERN) ||
        (botUsername ? text.match(buildReviewCommandHeadPattern(botUsername)) : null);
    if (!head) return undefined;

    return normalizeReviewDirective(
        text
            .slice(head[0].length)
            .split(/\r?\n/)[0]
            .trim()
            .replace(/^["'`]+|["'`]+$/g, '')
            // Drop `--heavy`/`--force` flags left ANYWHERE in the directive.
            // The head pattern only eats LEADING flags, so a flag placed after
            // (or between) the focus text — `@kody review auth --heavy` — would
            // otherwise pollute the <ReviewFocus> hint. `\b` keeps focus words
            // like "forced"/"heavyweight" intact; the global flag handles
            // multiple flags in any order. Whitespace is collapsed downstream.
            .replace(/\s*--?(?:heavy|force)\b/gi, ''),
    );
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
    botUsername?: string | null,
): boolean => {
    if (!text) return false;
    if (KODY_MENTION_NON_REVIEW_PATTERN.test(text)) return true;
    if (botUsername && buildMentionNonReviewPattern(botUsername).test(text))
        return true;
    return false;
};
