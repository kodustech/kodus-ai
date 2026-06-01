/**
 * Pure helpers for managing bulk-selection state of Kody Rules.
 *
 * The selection lives as a `Set<string>` of rule UUIDs in page state.
 * Keeping the toggling/selection logic in a small pure module makes it
 * easy to test (no React, no mocks) and keeps the page component focused
 * on layout.
 *
 * Selection only applies to rules that the user can actually delete (no
 * inherited rules, no centralized-config-pending rules) — the caller is
 * responsible for filtering the eligible set.
 */

export function toggleRuleSelection(
    selection: ReadonlySet<string>,
    ruleId: string,
): Set<string> {
    const next = new Set(selection);
    if (next.has(ruleId)) {
        next.delete(ruleId);
    } else {
        next.add(ruleId);
    }
    return next;
}

export function selectAll(
    selection: ReadonlySet<string>,
    eligibleIds: ReadonlyArray<string>,
): Set<string> {
    const next = new Set(selection);
    for (const id of eligibleIds) next.add(id);
    return next;
}

export function clearSelection(): Set<string> {
    return new Set();
}

/**
 * Returns true when EVERY eligible id is already selected. Used by the
 * "select all" checkbox to render its tri-state correctly:
 *   - all  → "all selected" (uncheck on click)
 *   - some → "indeterminate"
 *   - none → "none selected" (check on click)
 */
export function getSelectAllState(
    selection: ReadonlySet<string>,
    eligibleIds: ReadonlyArray<string>,
): "all" | "some" | "none" {
    if (eligibleIds.length === 0) return "none";
    let selectedCount = 0;
    for (const id of eligibleIds) {
        if (selection.has(id)) selectedCount += 1;
    }
    if (selectedCount === 0) return "none";
    if (selectedCount === eligibleIds.length) return "all";
    return "some";
}

/**
 * Drops any selected ids that no longer exist in the visible/eligible
 * set. Useful after the user changes filters or refreshes the list —
 * stale selections would otherwise produce ghost-counts in the toolbar.
 */
export function pruneSelection(
    selection: ReadonlySet<string>,
    eligibleIds: ReadonlyArray<string>,
): Set<string> {
    const eligible = new Set(eligibleIds);
    const next = new Set<string>();
    for (const id of selection) {
        if (eligible.has(id)) next.add(id);
    }
    return next;
}
