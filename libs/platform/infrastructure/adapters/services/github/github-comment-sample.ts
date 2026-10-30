/**
 * Shaping helpers for the repository-level comment sample used by Kody-rules
 * generation (see `GithubService.getRecentRepositoryComments`).
 *
 * Kept out of the service so the part with actual decisions in it — which
 * comments belong to a pull request, which PR each one belongs to, and where
 * the file paths come from — is testable without an Octokit or a network.
 */

export interface SampledPullRequestComments {
    pr: { pull_number: number };
    generalComments: any[];
    reviewComments: any[];
    files: { filename: string }[];
}

/**
 * Pull the PR/issue number out of an API url.
 *
 * Anchored on the trailing segment so a repository whose OWNER or NAME
 * contains "pulls" or "issues" cannot shift the match onto the wrong number.
 */
export function pullRequestNumberFromUrl(url?: string): number | undefined {
    const match = /\/(?:pulls|issues)\/(\d+)(?:$|[/?#])/.exec(url ?? '');
    return match ? Number(match[1]) : undefined;
}

/**
 * On GitHub every pull request is also an issue, so
 * `GET /repos/{owner}/{repo}/issues/comments` returns comments from both.
 * Only the html_url distinguishes them: PR conversation comments live under
 * `/pull/<n>`, plain issue comments under `/issues/<n>`.
 *
 * Getting this wrong feeds issue chatter into rule generation, which is how a
 * bug report's discussion turns into a coding convention.
 */
export function isPullRequestIssueComment(comment: {
    html_url?: string;
}): boolean {
    return /\/pull\/\d+/.test(comment?.html_url ?? '');
}

/**
 * Group a flat comment sample by pull request.
 *
 * `files` is derived from the `path` each review comment was left on, not
 * fetched. The only consumer of that field counts extensions to tag comments
 * with a language (`commentAnalysis.service.fileExtensionFrequencyAnalysis`
 * reads nothing but `filename`), so the per-PR files request it used to cost —
 * one third of all requests in the old shape — bought data we already had.
 *
 * A PR contributes an entry as soon as it has any comment; a PR whose only
 * comments are conversation comments simply gets an empty `files`, which
 * downstream reads as "no language tag", exactly as a failed files fetch did.
 */
export function groupCommentsByPullRequest(
    reviewComments: Array<{ pull_request_url?: string; path?: string }>,
    issueComments: Array<{ issue_url?: string; html_url?: string }>,
): SampledPullRequestComments[] {
    const byPr = new Map<number, SampledPullRequestComments>();

    const bucket = (prNumber: number): SampledPullRequestComments => {
        let entry = byPr.get(prNumber);
        if (!entry) {
            entry = {
                pr: { pull_number: prNumber },
                generalComments: [],
                reviewComments: [],
                files: [],
            };
            byPr.set(prNumber, entry);
        }
        return entry;
    };

    for (const comment of reviewComments ?? []) {
        const prNumber = pullRequestNumberFromUrl(comment?.pull_request_url);
        if (prNumber === undefined) {
            continue;
        }
        const entry = bucket(prNumber);
        entry.reviewComments.push(comment);
        if (comment?.path) {
            entry.files.push({ filename: comment.path });
        }
    }

    for (const comment of issueComments ?? []) {
        if (!isPullRequestIssueComment(comment)) {
            continue;
        }
        const prNumber = pullRequestNumberFromUrl(comment?.issue_url);
        if (prNumber === undefined) {
            continue;
        }
        bucket(prNumber).generalComments.push(comment);
    }

    return [...byPr.values()];
}
