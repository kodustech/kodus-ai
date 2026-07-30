/**
 * task-context — leaf text utilities (pure, dependency-free).
 *
 * Extracted from the 2155-line task-context-read monolith as the foundation of
 * its decomposition: these are the bottom of the dependency graph (no calls to
 * other task-context helpers), so they move out cleanly and everything else can
 * import them without cycles.
 */

/** Parse a string ONLY if it looks like a JSON object/array; undefined otherwise. */
export function tryParseJsonString(value: string): unknown | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (
        !(
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))
        )
    ) {
        return undefined;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

/** First non-blank string in the list, or undefined. */
export function firstNonEmptyString(values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

/** First meaningful value: a non-blank string, or any non-null/undefined value. */
export function firstNonEmptyValue(values: unknown[]): unknown {
    for (const value of values) {
        if (typeof value === 'string') {
            if (value.trim().length > 0) {
                return value;
            }
            continue;
        }

        if (value !== undefined && value !== null) {
            return value;
        }
    }

    return undefined;
}

/** Strip to alphanumerics, lowercased — for loose parameter-name matching. */
export function normalizeParamName(value: string): string {
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Dedupe, dropping blanks. */
export function uniqueNonEmpty(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}
