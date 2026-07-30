/**
 * Helpers for reading per-(repository, directory) rule counts returned by the
 * aggregated `/kody-rules/counts-by-repository` endpoint. Kept pure (no React)
 * so the keying logic — the part prone to a repo-vs-directory mismatch — is
 * unit-testable in isolation.
 */
export type KodyRuleRepositoryCount = {
    repositoryId: string;
    directoryId: string | null;
    count: number;
};

/**
 * Repository-level rules group under the repo id alone; directory-level rules
 * under "<repoId>::<directoryId>". Must match how the backend groups, where a
 * repository-level rule has `directoryId === null`. A falsy directoryId
 * (undefined / null / "") is treated as repository-level.
 */
export function repoCountKey(
    repositoryId: string,
    directoryId?: string | null,
): string {
    return directoryId ? `${repositoryId}::${directoryId}` : repositoryId;
}

/**
 * Resolves the count for a given (repository, directory) from the aggregated
 * list. Returns 0 when there is no matching entry (no rules for that scope).
 */
export function resolveRepoCount(
    counts: KodyRuleRepositoryCount[] | undefined,
    repositoryId: string,
    directoryId?: string | null,
): number {
    if (!counts) return 0;
    const target = repoCountKey(repositoryId, directoryId);
    const entry = counts.find(
        (c) => repoCountKey(c.repositoryId, c.directoryId) === target,
    );
    return entry?.count ?? 0;
}
