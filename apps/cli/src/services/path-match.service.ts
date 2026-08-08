/**
 * Path-keyed decision matching. Exact or prefix comparison only —
 * no embeddings, no vector store, no similarity search.
 */

export function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * True when `decisionPath` matches any of `queryPaths` by exact equality
 * or as a parent/child prefix of one another.
 */
export function pathMatches(
    decisionPath: string,
    queryPaths: string[],
): boolean {
    const dp = normalizePath(decisionPath);
    if (!dp) {
        return false;
    }
    for (const q of queryPaths) {
        const qp = normalizePath(q);
        if (!qp) {
            continue;
        }
        if (dp === qp) {
            return true;
        }
        // Decision scoped to a directory that contains the query path
        if (qp.startsWith(dp + '/')) {
            return true;
        }
        // Decision scoped to a file under a queried directory
        if (dp.startsWith(qp + '/')) {
            return true;
        }
        // File basename-only match when decision lists just the filename
        if (dp === qp.split('/').pop()) {
            return true;
        }
    }
    return false;
}

/**
 * Filter decisions whose `paths` (or evidence file refs) match any query path.
 * Decisions with no path scope match nothing for path-scoped recall (they may
 * still appear in session-level views).
 */
export function filterDecisionsByPaths<
    T extends { paths?: string[]; evidence?: string[]; forgotten?: boolean },
>(decisions: T[], queryPaths: string[]): T[] {
    if (queryPaths.length === 0) {
        return decisions.filter((d) => !d.forgotten);
    }
    return decisions.filter((d) => {
        if (d.forgotten) {
            return false;
        }
        const scopes = [
            ...(d.paths ?? []),
            ...(d.evidence ?? []).filter(
                (e) => e.includes('/') || e.includes('.'),
            ),
        ];
        if (scopes.length === 0) {
            return false;
        }
        return scopes.some((s) => pathMatches(s, queryPaths));
    });
}
