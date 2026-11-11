import picomatch from 'picomatch';

/**
 * PERF: Cache for compiled glob matchers.
 *
 * Problem: picomatch compilation is expensive (~0.6% per PR for 150 files × 10 patterns)
 * Solution: Cache compiled matchers by pattern string
 *
 * The cache is bounded by MAX_CACHE_SIZE to prevent memory leaks.
 *
 * Sizing: every team's default `ignorePaths` carries ~1,100 patterns since
 * the global ignore list moved into the setting (migration
 * 2026082700000000-BackfillIgnorePathsFromGlobalList). The previous bound
 * was 500 with a clear-all eviction: walking a 1,100-pattern list filled
 * the cache, wiped it, and refilled it on every file, so no lookup ever
 * hit and every pattern was recompiled for every file. On a 970-file PR
 * that blocked the worker event loop for ~30s in production.
 *
 * The bound now holds the default list plus team-specific patterns, and a
 * full cache drops one slice (second chance) instead of everything, so a
 * working set below the bound is never wiped and patterns in use survive
 * churn from patterns that are not.
 */
type CachedMatcher = { matcher: picomatch.Matcher; used: boolean };

const MATCHER_CACHE_CASE_SENSITIVE = new Map<string, CachedMatcher>();
const MATCHER_CACHE_CASE_INSENSITIVE = new Map<string, CachedMatcher>();
const MAX_CACHE_SIZE = 5_000;
/** Share of the cache dropped when it is full. */
const EVICTION_BATCH = Math.ceil(MAX_CACHE_SIZE / 10);

/**
 * Second-chance eviction: walk in insertion order, drop entries not hit
 * since the last eviction and clear the flag on the ones that were, so the
 * shared default ignore list (hit on every file) is kept while one-off
 * patterns go. A hit only sets a flag — no Map reordering on the hot path,
 * which a strict LRU would pay on every file × pattern lookup.
 */
function evictSlice(cache: Map<string, CachedMatcher>): void {
    let removed = 0;
    for (const [key, entry] of cache) {
        if (removed >= EVICTION_BATCH) {
            return;
        }
        if (entry.used) {
            entry.used = false;
            continue;
        }
        cache.delete(key);
        removed++;
    }
    // Everything was in use: fall back to the oldest-inserted entries.
    for (const key of cache.keys()) {
        if (removed >= EVICTION_BATCH) {
            return;
        }
        cache.delete(key);
        removed++;
    }
}

/**
 * Gets or creates a cached matcher for a pattern.
 * @param pattern The glob pattern
 * @param caseInsensitive Whether to match case-insensitively
 * @returns Compiled picomatch matcher function
 */
function getCachedMatcher(
    pattern: string,
    caseInsensitive: boolean,
): picomatch.Matcher {
    const cache = caseInsensitive
        ? MATCHER_CACHE_CASE_INSENSITIVE
        : MATCHER_CACHE_CASE_SENSITIVE;

    const cached = cache.get(pattern);
    if (cached) {
        cached.used = true;
        return cached.matcher;
    }

    // Never clear-all: see the cache sizing note above.
    if (cache.size >= MAX_CACHE_SIZE) {
        evictSlice(cache);
    }

    const matcher = picomatch(pattern, {
        dot: true,
        nocase: caseInsensitive,
    });
    cache.set(pattern, { matcher, used: false });

    return matcher;
}

/**
 * Normalizes a filename for consistent matching across platforms and providers.
 * @param filename The filename to normalize
 * @returns Normalized filename
 */
function normalizeFilename(filename: string): string {
    return (filename || '')
        .replace(/\\/g, '/') // Convert backslashes to forward slashes
        .replace(/^\.\/+/, '') // Remove leading './' segments
        .replace(/^\/+/, ''); // Remove leading '/' so patterns like '.cursor/**' match '/.cursor/**'
}

/**
 * Checks if a file matches any of the provided Glob patterns.
 * @param filename Name of the file to be checked.
 * @param patterns Array of Glob patterns.
 * @returns Boolean indicating whether the file matches any pattern.
 */
export const isFileMatchingGlob = (
    filename: string,
    patterns: string[],
): boolean => {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    const normalizedFilename = normalizeFilename(filename);

    // PERF: Use cached matchers instead of recompiling each time
    // Before: 150 files × 10 patterns = 1,500 compilations per PR
    // After:  10 patterns compiled once, reused for all files
    for (const pattern of patterns) {
        const matcher = getCachedMatcher(pattern, false);
        if (matcher(normalizedFilename)) {
            return true;
        }
    }

    return false;
};

/**
 * Checks if a file matches any of the provided Glob patterns (case-insensitive).
 * Useful for external file references where users might not remember exact casing.
 * @param filename Name of the file to be checked.
 * @param patterns Array of Glob patterns.
 * @returns Boolean indicating whether the file matches any pattern (ignoring case).
 */
export const isFileMatchingGlobCaseInsensitive = (
    filename: string,
    patterns: string[],
): boolean => {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    const normalizedFilename = normalizeFilename(filename);

    for (const pattern of patterns) {
        const matcher = getCachedMatcher(pattern, true);
        if (matcher(normalizedFilename)) {
            return true;
        }
    }

    return false;
};

/**
 * Clears the matcher cache. Useful for testing or memory management.
 * @internal Exported for testing purposes only
 */
export const _clearMatcherCache = (): void => {
    MATCHER_CACHE_CASE_SENSITIVE.clear();
    MATCHER_CACHE_CASE_INSENSITIVE.clear();
};

/**
 * Gets the current cache size. Useful for monitoring.
 * @internal Exported for testing purposes only
 */
export const _getMatcherCacheSize = (): {
    caseSensitive: number;
    caseInsensitive: number;
} => ({
    caseSensitive: MATCHER_CACHE_CASE_SENSITIVE.size,
    caseInsensitive: MATCHER_CACHE_CASE_INSENSITIVE.size,
});
