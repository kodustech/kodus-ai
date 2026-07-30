/**
 * Pure helpers for the Kody Rules list filters.
 *
 * Filters are stored as Sets so the UI can model "no filter" (empty set) and
 * "match any of N" (multi-select within a section) without ambiguity.
 *
 *   - origins / severities are OR within their own section.
 *   - Combining sections is AND (a rule must pass every active section).
 *
 * The helpers here only cover the *new* filter sections (origin + severity).
 * Inheritance scope filtering (`VisibleScopes`) lives in the page itself
 * because it requires the inheritance metadata that the listing API attaches.
 */
import { inferRuleOrigin, type InferredRuleOrigin } from './infer-origin';

export type ListFilters = {
    origins: Set<InferredRuleOrigin>;
    severities: Set<string>; // lower-case (low/medium/high/critical)
    /** Toggle: when true, only Auto-sync rules pinned via `@kody-sync` pass. */
    kodySync: boolean;
    withSyncErrors: boolean;
    /** Toggle: when true, only rules with status === "paused" pass the filter. */
    pausedOnly: boolean;
};

export const EMPTY_LIST_FILTERS: ListFilters = {
    origins: new Set(),
    severities: new Set(),
    kodySync: false,
    withSyncErrors: false,
    pausedOnly: false,
};

export function matchesOriginFilter(
    rule: { sourcePath?: string | null; origin?: string | null },
    filters: ListFilters,
): boolean {
    if (filters.origins.size === 0) return true;
    return filters.origins.has(inferRuleOrigin(rule));
}

/**
 * An auto-synced rule left behind after auto-sync went off — an "orphan".
 * Single source of truth for the orphan chip's count, its quick-filter, AND
 * the per-card "Orphan" maintenance badge (`OriginBadge`) so all three can
 * never disagree (the original "count differs from filtered result" bug, and
 * its later "3 badges but chip says 2" variant, both came from divergent
 * predicates).
 *
 * INHERITED rules ARE counted: this is a per-repository view and an inherited
 * global/parent orphan still affects this repo's reviews, so it belongs in
 * "orphans affecting this repo". (Trade-off: the same global orphan is counted
 * in every repo that inherits it — accepted, because each repo's chip is about
 * that repo. The fix itself is still made at the rule's owning scope.)
 *
 * Excludes only:
 *   - pinnedSync rules — their source file carries `@kody-sync`, so the
 *     backend keeps syncing them even with the toggle off (maintained, not
 *     orphaned). This mirrors the badge, which hides on pinned rules too.
 *
 * NOTE: this predicate does not test the repo's auto-sync toggle. Callers gate
 * on it separately (the chip only renders when sync is off, and the badge only
 * renders for `syncEnabledForRepo === false`), so both surfaces already agree.
 */
export function isOrphanAutoSyncRule(rule: {
    sourcePath?: string | null;
    origin?: string | null;
    pinnedSync?: boolean;
}): boolean {
    return inferRuleOrigin(rule) === 'Auto-sync' && !rule.pinnedSync;
}

export function matchesSeverityFilter(
    rule: { severity?: string | null },
    filters: ListFilters,
): boolean {
    if (filters.severities.size === 0) {
        return true;
    }
    if (!rule.severity) {
        return false;
    }
    return filters.severities.has(rule.severity.toLowerCase());
}

/**
 * @kody-sync filter: only Auto-sync rules still pinned via `@kody-sync`
 * (`pinnedSync`) pass. Everything else is excluded while it's on.
 */
export function matchesKodySyncFilter(
    rule: {
        sourcePath?: string | null;
        origin?: string | null;
        pinnedSync?: boolean | null;
    },
    filters: ListFilters,
): boolean {
    if (!filters.kodySync) {
        return true;
    }
    return inferRuleOrigin(rule) === 'Auto-sync' && rule.pinnedSync === true;
}

export function hasActiveListFilters(filters: ListFilters): boolean {
    return (
        filters.origins.size > 0 ||
        filters.severities.size > 0 ||
        filters.kodySync ||
        filters.withSyncErrors ||
        filters.pausedOnly
    );
}

export function matchesSyncErrorsFilter(
    rule: { syncErrors?: unknown },
    filters: ListFilters,
): boolean {
    if (!filters.withSyncErrors) {
        return true;
    }
    return Array.isArray(rule.syncErrors) && rule.syncErrors.length > 0;
}

export function matchesPausedOnlyFilter(
    rule: { status?: string | null },
    filters: ListFilters,
): boolean {
    if (!filters.pausedOnly) {
        return true;
    }
    return rule.status === 'paused';
}

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

export type SortOption = 'recent' | 'severity-desc' | 'alphabetical';

export function compareRules(
    a: {
        title?: string;
        severity?: string | null;
        updatedAt?: string | Date | null;
        createdAt?: string | Date | null;
    },
    b: {
        title?: string;
        severity?: string | null;
        updatedAt?: string | Date | null;
        createdAt?: string | Date | null;
    },
    option: SortOption,
): number {
    if (option === 'alphabetical') {
        return (a.title ?? '').localeCompare(b.title ?? '');
    }
    if (option === 'severity-desc') {
        const aRank = SEVERITY_RANK[(a.severity ?? '').toLowerCase()] ?? 99;
        const bRank = SEVERITY_RANK[(b.severity ?? '').toLowerCase()] ?? 99;
        if (aRank !== bRank) {
            return aRank - bRank;
        }
        return (a.title ?? '').localeCompare(b.title ?? '');
    }
    // recent
    const aTime = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
    const bTime = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
    return bTime - aTime;
}

/**
 * Lower-cases the haystack once and tests every searched field. Returns true
 * when the rule matches the (already lower-cased) `query`. Empty query → true.
 *
 * Searches title, path, sourcePath, the rule body itself, and the example
 * snippets — letting users find a rule by something they remember from any
 * surface area (not just the title).
 */
export function matchesTextQuery(
    rule: {
        title?: string;
        path?: string;
        sourcePath?: string | null;
        rule?: string;
        examples?: Array<{ snippet?: string }>;
    },
    queryLowercase: string,
): boolean {
    if (!queryLowercase) return true;
    const haystacks: Array<string | undefined | null> = [
        rule.title,
        rule.path,
        rule.sourcePath,
        rule.rule,
    ];
    for (const text of haystacks) {
        if (text && text.toLowerCase().includes(queryLowercase)) return true;
    }
    if (Array.isArray(rule.examples)) {
        for (const example of rule.examples) {
            if (
                example?.snippet &&
                example.snippet.toLowerCase().includes(queryLowercase)
            ) {
                return true;
            }
        }
    }
    return false;
}
