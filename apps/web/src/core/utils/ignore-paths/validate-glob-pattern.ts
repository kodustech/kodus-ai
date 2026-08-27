import picomatch from "picomatch";

/**
 * Answers one narrow question: is this string syntactically a glob?
 *
 * It is NOT a check that the pattern is useful. `**\/ / / / / 6 5 8` passes —
 * it compiles to a working regex that matches paths whose directories are
 * named " ". No library can tell that apart from an intentional pattern, so
 * the UI must not phrase the result as "this will work".
 *
 * picomatch is the same engine the review pipeline matches with, and
 * `strictBrackets` is the only mode in either matcher that reports a syntax
 * error at all — by default both picomatch and minimatch downgrade a broken
 * `[`, `{` or `(` to literal text and never throw. minimatch (used for
 * matching elsewhere in the web) has no equivalent option, which is why this
 * one check reaches for picomatch directly.
 */
export type GlobPatternCheck =
    { valid: true } | { valid: false; message: string };

export function checkGlobPatternSyntax(pattern: string): GlobPatternCheck {
    const trimmed = pattern.trim();

    // picomatch throws on "" too, but "type something" is not a syntax error.
    if (!trimmed) return { valid: false, message: "Type a pattern to add it." };

    try {
        picomatch(trimmed, { strictBrackets: true });
        return { valid: true };
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "This is not a valid glob pattern.";

        // strictBrackets also rejects an unmatched CLOSING "]" or ")", but
        // those are not broken: the default matcher treats them as literal
        // text, so `report]final.txt` ignores exactly the file the user meant.
        // Only a missing closing delimiter is a real finding — that is the
        // case where the construct silently degrades to literal text and the
        // pattern stops doing what was intended.
        if (!message.startsWith("Missing closing")) return { valid: true };

        return { valid: false, message };
    }
}

/**
 * A leading "!" that is not opening an extglob. `!(foo).js` is an extglob
 * matching one segment and is fine; `!src/**` is a negation.
 */
function isNegation(pattern: string): boolean {
    return pattern.startsWith("!") && pattern[1] !== "(";
}

/**
 * Whether a pattern can be added to the ignore list — syntax, plus the rules
 * that only apply because of how this particular list is evaluated.
 *
 * The review ORs the list over independently-compiled matchers
 * (`isFileMatchingGlob`), with no ordered re-inclusion the way .gitignore has.
 * A negation therefore does the opposite of what someone reaching for
 * gitignore habits expects: `!src/**` matches every file OUTSIDE src/, so
 * adding it silently drops almost the whole repository from review. Nothing
 * in the list can add a file back, so a negation is never useful here — only
 * destructive. None of the shipped defaults use one.
 */
export function checkIgnorePattern(pattern: string): GlobPatternCheck {
    const syntax = checkGlobPatternSyntax(pattern);
    if (!syntax.valid) return syntax;

    if (isNegation(pattern.trim())) {
        return {
            valid: false,
            message:
                'Negated patterns are not supported here — "!" would ignore every file the rest of the pattern does NOT match.',
        };
    }

    return { valid: true };
}
