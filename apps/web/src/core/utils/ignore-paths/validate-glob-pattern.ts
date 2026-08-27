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
