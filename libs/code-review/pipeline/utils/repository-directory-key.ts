/**
 * Composite group key for the PostHog `repositoryDirectory` group type
 * — pairs a repository id with one of its configured directory ids so
 * the agent-review opt-out can target a directory *within a specific
 * repo*, not directory ids in the abstract.
 *
 * The wildcard variant (`${repoId}:*`) represents a repo-wide opt-out
 * — used when a repository has no directories configured, or when you
 * want every PR in a repo to drop to EE regardless of touched paths.
 *
 * The script in `scripts/set-agent-review-directory-optout.ts` builds
 * the same keys when populating the PostHog flag; both sides must agree
 * on the separator and sentinel.
 */
export const REPOSITORY_DIRECTORY_KEY_SEPARATOR = ':';

/**
 * Sentinel that means "any directory in this repo" — used to form the
 * repo-wide composite key. `*` is visually unambiguous in the PostHog
 * UI and can't collide with a UUID-shaped directory id.
 */
export const REPOSITORY_WIDE_DIRECTORY_SENTINEL = '*';

export function buildRepositoryDirectoryKey(
    repositoryId: string,
    directoryId: string,
): string {
    return `${repositoryId}${REPOSITORY_DIRECTORY_KEY_SEPARATOR}${directoryId}`;
}

export function buildRepositoryWideKey(repositoryId: string): string {
    return buildRepositoryDirectoryKey(
        repositoryId,
        REPOSITORY_WIDE_DIRECTORY_SENTINEL,
    );
}
