/** Longest user or model pattern we run. A line or id matcher is short;
 *  anything longer is more likely an unbounded/backtracking construct. */
export const MAX_PATTERN_LEN = 200;

/**
 * Reject regex shapes prone to catastrophic backtracking (ReDoS). A model or a
 * user can write a pattern like `(a+)+$` that matches its examples and still
 * hangs on a long adversarial line. This is a conservative heuristic — a
 * quantifier applied to a group/class that itself contains a quantifier — plus
 * a length cap. Callers also bound the text they run a pattern on.
 */
export function isRegexSafe(pattern: string): boolean {
    if (!pattern || pattern.length > MAX_PATTERN_LEN) return false;
    // Nested quantifier: a group or char-class that itself contains a
    // quantifier-ish char (+/*/}), followed by an outer quantifier —
    // the classic ReDoS shape. The outer quantifier must be matched in
    // full (*, +, {n,}, {n,m}) — an earlier version only matched a bare
    // `*`/`+` right after the group, so bounded forms like `(a+){3,}` or
    // `(a*){5}` (both valid, both still catastrophic) slipped through.
    // The char-class branch requires the SAME inner-quantifier-char
    // check as the group branch — without it, this flagged every
    // ordinary `[a-z]+`-shaped detector as unsafe, which would have
    // declined nearly every char-class-based pattern.
    const NESTED_QUANTIFIER =
        /(\([^()]*[+*}][^()]*\)|\[[^\]]*[+*}][^\]]*\])\s*([*+]|\{\d+,?\d*\})/;
    return !NESTED_QUANTIFIER.test(pattern);
}
