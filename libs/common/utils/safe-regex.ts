/** Longest user or model pattern we run. A line or id matcher is short;
 *  anything longer is more likely an unbounded/backtracking construct. */
export const MAX_PATTERN_LEN = 200;

/**
 * Reject regex shapes prone to catastrophic backtracking (ReDoS). A model or a
 * user can write a pattern like `(a+)+$` or `(a|a)*$` that matches its
 * examples and still hangs on a long adversarial line. Conservative: any
 * repeated group whose body (nested groups included) holds a quantifier or an
 * alternation (or an optional part) is refused, as is a repeated char class holding a quantifier
 * char, plus a length cap. Callers also bound the text they run a pattern on.
 */
export function isRegexSafe(pattern: string): boolean {
    if (!pattern || pattern.length > MAX_PATTERN_LEN) return false;
    // Escapes (`\+`, `\(`) are literals, not structure.
    const bare = pattern.replace(/\\./g, '_');
    const opens: number[] = [];
    for (let i = 0; i < bare.length; i++) {
        const ch = bare[i];
        if (ch === '[') {
            const end = bare.indexOf(']', i + 1);
            if (end < 0) return false;
            if (
                /[+*}]/.test(bare.slice(i + 1, end)) &&
                repeats(bare, end + 1)
            ) {
                return false;
            }
            i = end;
        } else if (ch === '(') {
            opens.push(i);
        } else if (ch === ')') {
            const start = opens.pop();
            if (start === undefined) return false;
            const body = bare
                .slice(start + 1, i)
                .replace(/^\?[:=!]|^\?<[=!]?\w*>?/, '');
            if (/[+*?|{]/.test(body) && repeats(bare, i + 1)) {
                return false;
            }
        }
    }
    return opens.length === 0;
}

/** Whether the token at `index` repeats what precedes it: `*`, `+`, `{n,}`, `{n,m}`. */
function repeats(pattern: string, index: number): boolean {
    return /^\s*([*+]|\{\d+,?\d*\})/.test(pattern.slice(index));
}
