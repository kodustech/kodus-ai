/**
 * Makes a value safe to store in a Postgres `jsonb` column.
 *
 * Postgres rejects two things that JavaScript strings happily carry, and
 * both reach us through `session_events.payload` — CLI/LLM conversation
 * text that nobody sanitised upstream:
 *
 *   U+0000     ERROR: unsupported Unicode escape sequence
 *              DETAIL: \u0000 cannot be converted to text.
 *
 *   lone       ERROR: invalid input syntax for type json
 *   surrogate  DETAIL: Unicode low surrogate must follow a high surrogate.
 *
 * The failing INSERT takes the whole row with it, so each occurrence is a
 * dropped event.
 *
 * WHY THIS OPERATES ON THE OBJECT AND NOT ON THE SERIALISED JSON
 *
 * The obvious-looking fix — `JSON.stringify(x).replace(/\u0000/g, '')` —
 * does nothing at all. `JSON.stringify` has already turned the real
 * U+0000 code point into the six-character text `\u0000`, so no U+0000 is
 * left in the output for that regex to match. (There is a copy of exactly
 * that no-op in
 * `libs/ee/analytics-warehouse/ingestion/pull-request-ingestion.service.ts`;
 * it does work for the plain-`text` column it also guards, just not for
 * the json one.)
 *
 * Matching the escape as text instead would be worse: a string that
 * legitimately contains the six characters `\u0000` serialises to
 * `\\u0000`, which Postgres accepts and stores as text. Rewriting that
 * would corrupt real data.
 *
 * Cleaning the strings before serialisation avoids both traps.
 */

const NULL_CHAR = /\u0000/g;

/**
 * A high surrogate with no low surrogate after it, or a low surrogate
 * with no high surrogate before it. Well-formed pairs are left alone, so
 * emoji and other astral-plane characters survive untouched.
 */
const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** U+FFFD REPLACEMENT CHARACTER — the standard stand-in for undecodable input. */
const REPLACEMENT = '�';

const sanitizeString = (value: string): string =>
    value.replace(NULL_CHAR, '').replace(LONE_SURROGATE, REPLACEMENT);

/**
 * Recursion ceiling. Payloads are parsed request bodies, so they cannot
 * contain cycles, but a malformed one could still be deep enough to blow
 * the stack. Past the limit we drop the subtree rather than throw: losing
 * a nested corner of the payload beats losing the event, which is the
 * whole point of this module.
 */
const MAX_DEPTH = 64;

function sanitize(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
        return sanitizeString(value);
    }

    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (depth >= MAX_DEPTH) {
        return null;
    }

    // Dates carry no user text and JSON.stringify already handles them.
    if (value instanceof Date) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        // Keys land in the jsonb document too, so they need the same
        // treatment — a NUL in a key fails the INSERT just as hard.
        out[sanitizeString(key)] = sanitize(item, depth + 1);
    }
    return out;
}

/**
 * Returns a copy of `value` with every string cleaned of the characters
 * Postgres `jsonb` refuses. The input is never mutated.
 */
export function sanitizeForJsonb<T>(value: T): T {
    return sanitize(value, 0) as T;
}
