/** Shorter than this, a sha prefix may match more than one commit. */
const MIN_SHORT_SHA = 7;

/**
 * The commit a review read, as listed in the PR, or undefined when it is no
 * longer part of it. Bitbucket's webhook carries a 12-character sha while the
 * list has full ones, so a prefix also counts; the full sha is returned.
 */
export function reviewedCommitIn(
    commits: ReadonlyArray<{ sha?: string }> | undefined,
    reviewedSha: string | undefined,
): { sha: string } | undefined {
    if (!reviewedSha) return undefined;
    const match = commits?.find(
        (commit) =>
            commit?.sha === reviewedSha ||
            (reviewedSha.length >= MIN_SHORT_SHA &&
                !!commit?.sha?.startsWith(reviewedSha)),
    );
    return match?.sha ? { sha: match.sha } : undefined;
}
