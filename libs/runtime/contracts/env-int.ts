// The one integer parser of the Runtime's config loaders (apps/runtime
// shared/config.ts, the API's runtime-api.config.ts). A value is trimmed
// first, and a blank or whitespace-only value counts as unset, so it takes the
// default (`Number('  ')` would read as 0).

/** undefined when unset or blank, null when it is not an integer, else the integer. */
export function envInteger(raw: string | undefined): number | null | undefined {
    const value = raw?.trim();
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
}

/** Strict, for the Runtime processes: a malformed or out-of-range value stops the boot. */
export function requireEnvInt(name: string, raw: string | undefined, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
    const n = envInteger(raw);
    if (n === undefined) return fallback;
    if (n === null || n < min) throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
    if (n > max) throw new Error(`${name} must be <= ${max}`);
    return n;
}

/** Lenient, for the product API: a malformed or too-small value takes the default, never stops the product. */
export function envIntOr(raw: string | undefined, fallback: number, min = 0): number {
    const n = envInteger(raw);
    return n === undefined || n === null || n < min ? fallback : n;
}
