import * as vm from 'node:vm';

import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('SafeRegex');

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

/** One match of {@link matchAllWithin}: where it starts, its text and its first group. */
export interface BoundedMatch {
    index: number;
    text: string;
    group?: string;
}

/**
 * Every match of a user's pattern in `text`, stopped after `timeoutMs`. The
 * shape check above can't see every slow pattern (`[A-Z]+\w*-\d+` grows
 * cubically on a long run of capitals), and the text is often the PR's own
 * title or description, which its author controls: V8 interrupts a regex that
 * runs past a script timeout, so the review never hangs on one. A pattern
 * that runs out of time, or doesn't compile, matches nothing and is logged.
 */
export function matchAllWithin(
    pattern: string,
    text: string,
    timeoutMs = 50,
): BoundedMatch[] {
    try {
        const found = vm.runInNewContext(
            'Array.from(text.matchAll(new RegExp(pattern, "g")), (m) => [m.index, m[0], m[1]])',
            { text, pattern },
            { timeout: timeoutMs },
        ) as Array<[number, string, string | undefined]>;
        return Array.from(found, ([index, match, group]) => ({
            index,
            text: match,
            ...(group !== undefined ? { group } : {}),
        }));
    } catch (error) {
        // The pattern and the text are the user's: log their sizes, not them.
        logger.warn({
            message: 'A user pattern was stopped or failed, read as no match',
            context: 'SafeRegex',
            metadata: {
                timeoutMs,
                patternLength: pattern.length,
                textLength: text.length,
                reason: error instanceof Error ? error.message : String(error),
            },
        });
        return [];
    }
}
