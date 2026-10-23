import * as vm from 'node:vm';

import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('SafeRegex');

/** One match of {@link matchAllWithin}: where it starts, its text and its first group. */
export interface BoundedMatch {
    index: number;
    text: string;
    group?: string;
}

/**
 * Every match of a user's pattern in `text`, stopped after `timeoutMs`. The
 * shape check in safe-regex.ts can't see every slow pattern (`[A-Z]+\w*-\d+` grows
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
