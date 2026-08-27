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
 * Index of the "]" closing the class opened at `start`, or -1 if unclosed.
 * A "]" in the first position (after an optional "!" or "^") is a literal
 * member of the class rather than its terminator — `[]]` holds "]", and
 * `[!]]` is "any character except ]".
 */
function findClassEnd(pattern: string, start: number): number {
    let i = start + 1;

    if (pattern[i] === "!" || pattern[i] === "^") i++;
    if (pattern[i] === "]") i++;

    for (; i < pattern.length; i++) {
        if (pattern[i] === "\\") {
            i++;
            continue;
        }
        if (pattern[i] === "]") return i;
    }

    return -1;
}

/**
 * Whether the pattern contains any negating construct: a leading "!", or an
 * extglob "!(...)" anywhere.
 *
 * An earlier version allowed "!(...)" on the theory that an extglob is bound
 * to one segment. It is not, once anything follows it. Measured against a
 * mixed corpus:
 *
 *   !(foo).js               1/11   bounded
 *   !(a|b)/**               7/11
 *   !(node_modules)/**     10/11
 *   **\/!(node_modules)/** 11/11   the entire repository
 *   **\/*.!(js)             8/11   negation is not even segment-leading here
 *
 * Every attempt to carve out a "safe" subset left a hole in a different
 * place, and the cost of getting it wrong is a customer's reviews silently
 * doing nothing. So the rule is the blunt one: no negation, in any position.
 * The list is an OR of "ignore this" with no re-inclusion, so a negation
 * never expresses something it can express another way.
 *
 * Bracket classes are left alone. `[!abc]` negates a single CHARACTER, not a
 * path — it is a wildcard in the same family as `*` and `?`, so `**\/[!_]*.ts`
 * ("ts files not starting with an underscore") is an ordinary ignore rule.
 * The scan therefore skips over classes: inside `[...]` a "!(" is the class's
 * own negation followed by a literal paren, not an extglob.
 */
function hasNegation(pattern: string): boolean {
    if (pattern.startsWith("!")) return true;

    for (let i = 0; i < pattern.length - 1; i++) {
        if (pattern[i] === "\\") {
            i++;
            continue;
        }

        if (pattern[i] === "[") {
            const end = findClassEnd(pattern, i);
            // An unterminated "[" never reaches here — checkGlobPatternSyntax
            // rejects it first — but treat it as literal rather than looping.
            if (end === -1) continue;
            i = end;
            continue;
        }

        if (pattern[i] === "!" && pattern[i + 1] === "(") return true;
    }

    return false;
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

    if (hasNegation(pattern.trim())) {
        return {
            valid: false,
            message:
                'Negation is not supported here — "!" ignores every file the rest of the pattern does NOT match, which usually means the whole repository.',
        };
    }

    return { valid: true };
}
