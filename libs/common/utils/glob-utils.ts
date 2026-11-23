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
 * PERF: a literal prefilter in front of picomatch.
 *
 * Problem: with the ~1,100-pattern default `ignorePaths`, every file runs
 * ~1,100 picomatch matchers, and each call allocates a result object and
 * runs `regex.exec`. A Bitbucket PR with 8,319 files held a worker's event
 * loop for 22s in this loop (StallWatchdog, 2026-11-23 10:58Z), with
 * `picomatch.test` as the hottest frame.
 *
 * Solution: a glob can only match a path that contains the glob's longest
 * literal run: `**\/*.png` needs `.png`, `**\/[Dd]ebug/**` needs `ebug`. A
 * pattern runs its matcher only when its literal is in the path, so most of
 * the list is skipped with a native `String.includes`. picomatch still
 * decides every match; the prefilter only skips matchers that cannot
 * return true, so results are unchanged.
 *
 * A pattern that can match without its literal gets no prefilter: a
 * negation (`!x`) or anything with `(`, `)` or `|` (extglob, groups,
 * alternation). Text inside `{}` and `[]` is a choice, so it never counts
 * as required. Splitting at more characters than strictly needed only
 * shortens the literal, which is still required.
 */
type PrefilteredPattern = {
    pattern: string;
    literal: string;
    /** Compiled on first use, as the per-pattern loop always did. */
    matcher?: picomatch.Matcher;
};
type CompiledPatternList = (normalizedFilename: string) => boolean;

const LITERAL_SPLIT = /[*?[\]{}()!+@\\/|,^$]/;
const NON_ASCII = /[^\p{ASCII}]/u;

/** Longer patterns may make picomatch throw; they always run. */
const MAX_PREFILTERED_PATTERN_LENGTH = 4_096;

/** @internal Exported for testing purposes only */
export function requiredLiteral(pattern: string): string {
    if (
        typeof pattern !== 'string' ||
        pattern.length > MAX_PREFILTERED_PATTERN_LENGTH ||
        pattern.startsWith('!') ||
        /[()|]/.test(pattern)
    ) {
        return '';
    }
    const withoutChoices = pattern
        .replace(/\{[^}]*\}/g, '/')
        .replace(/\[[^\]]*\]/g, '/');
    let best = '';
    for (const run of withoutChoices.split(LITERAL_SPLIT)) {
        if (run.length > best.length) {
            best = run;
        }
    }
    return best;
}

function compilePatternList(
    patterns: string[],
    caseInsensitive: boolean,
): CompiledPatternList {
    const entries: PrefilteredPattern[] = patterns.map((pattern) => {
        const literal = requiredLiteral(pattern);
        let folded = literal;
        if (caseInsensitive) {
            // Lower-casing is only a safe fold for ASCII; a non-ASCII
            // literal in a case-insensitive list always runs its matcher.
            folded = NON_ASCII.test(literal) ? '' : literal.toLowerCase();
        }
        return { pattern, literal: folded };
    });

    return (normalizedFilename: string): boolean => {
        // A non-ASCII path in a case-insensitive list skips the prefilter,
        // for the same folding reason as above.
        const prefilter = !(
            caseInsensitive && NON_ASCII.test(normalizedFilename)
        );
        const haystack = caseInsensitive
            ? normalizedFilename.toLowerCase()
            : normalizedFilename;
        for (const entry of entries) {
            if (
                prefilter &&
                entry.literal !== '' &&
                !haystack.includes(entry.literal)
            ) {
                continue;
            }
            // An invalid pattern throws here, when the loop reaches it,
            // exactly as the per-pattern loop did.
            entry.matcher ??= getCachedMatcher(entry.pattern, caseInsensitive);
            if (entry.matcher(normalizedFilename)) {
                return true;
            }
        }
        return false;
    };
}

/** Compiled lists by content, least recently used evicted first. */
const COMPILED_CASE_SENSITIVE = new Map<string, CompiledPatternList>();
const COMPILED_CASE_INSENSITIVE = new Map<string, CompiledPatternList>();
const MAX_COMPILED_LISTS = 256;

function getCompiledPatternList(
    patterns: string[],
    caseInsensitive: boolean,
): CompiledPatternList {
    const cache = caseInsensitive
        ? COMPILED_CASE_INSENSITIVE
        : COMPILED_CASE_SENSITIVE;
    const key = patterns.join('\u0000');
    const cached = cache.get(key);
    if (cached) {
        // Re-insert: Map order is the LRU order.
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    if (cache.size >= MAX_COMPILED_LISTS) {
        cache.delete(cache.keys().next().value);
    }
    const compiled = compilePatternList(patterns, caseInsensitive);
    cache.set(key, compiled);
    return compiled;
}

/**
 * Builds a matcher for one pattern list, for a loop over many files: the
 * list is looked up once here instead of once per file. The returned
 * function answers as `isFileMatchingGlob(filename, patterns)` would for
 * the list as it was when this was called.
 */
export const createGlobMatcher = (
    patterns: string[],
    options: { caseInsensitive?: boolean } = {},
): ((filename: string) => boolean) => {
    if (!patterns || patterns.length === 0) {
        return () => false;
    }
    const compiled = getCompiledPatternList(
        [...patterns],
        Boolean(options.caseInsensitive),
    );
    return (filename: string) => compiled(normalizeFilename(filename));
};

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

    return getCompiledPatternList(patterns, false)(normalizeFilename(filename));
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

    return getCompiledPatternList(patterns, true)(normalizeFilename(filename));
};

/**
 * Clears the matcher cache. Useful for testing or memory management.
 * @internal Exported for testing purposes only
 */
export const _clearMatcherCache = (): void => {
    MATCHER_CACHE_CASE_SENSITIVE.clear();
    MATCHER_CACHE_CASE_INSENSITIVE.clear();
    COMPILED_CASE_SENSITIVE.clear();
    COMPILED_CASE_INSENSITIVE.clear();
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
