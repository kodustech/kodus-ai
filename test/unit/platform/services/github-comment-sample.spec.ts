import {
    groupCommentsByPullRequest,
    isPullRequestIssueComment,
    pullRequestNumberFromUrl,
} from '@libs/platform/infrastructure/adapters/services/github/github-comment-sample';

const reviewComment = (prNumber: number, path?: string) => ({
    id: `${prNumber}-${path ?? 'nopath'}`,
    body: 'x'.repeat(120),
    pull_request_url: `https://api.github.com/repos/acme/web/pulls/${prNumber}`,
    ...(path ? { path } : {}),
});

const issueComment = (number: number, kind: 'pull' | 'issues') => ({
    id: `${kind}-${number}`,
    body: 'x'.repeat(120),
    issue_url: `https://api.github.com/repos/acme/web/issues/${number}`,
    html_url: `https://github.com/acme/web/${kind}/${number}#issuecomment-1`,
});

describe('pullRequestNumberFromUrl', () => {
    it('reads the number from pull and issue urls alike', () => {
        expect(
            pullRequestNumberFromUrl(
                'https://api.github.com/repos/acme/web/pulls/839',
            ),
        ).toBe(839);
        expect(
            pullRequestNumberFromUrl(
                'https://api.github.com/repos/acme/web/issues/12',
            ),
        ).toBe(12);
    });

    // A repo literally named "pulls" (or an org named "issues") is legal on
    // GitHub. An unanchored match would take the first segment it saw and
    // attribute every comment to whatever number followed it.
    it('is not fooled by a repo or owner named after the path segment', () => {
        expect(
            pullRequestNumberFromUrl(
                'https://api.github.com/repos/pulls/issues/pulls/77',
            ),
        ).toBe(77);
    });

    it('returns undefined rather than guessing', () => {
        expect(pullRequestNumberFromUrl(undefined)).toBeUndefined();
        expect(pullRequestNumberFromUrl('')).toBeUndefined();
        expect(
            pullRequestNumberFromUrl('https://api.github.com/repos/acme/web'),
        ).toBeUndefined();
    });
});

describe('isPullRequestIssueComment', () => {
    // The endpoint returns both kinds. Letting issue chatter through turns a
    // bug report's discussion into a coding convention.
    it('keeps PR conversation comments and drops issue comments', () => {
        expect(isPullRequestIssueComment(issueComment(4, 'pull'))).toBe(true);
        expect(isPullRequestIssueComment(issueComment(4, 'issues'))).toBe(
            false,
        );
    });

    it('drops a comment with no html_url instead of assuming', () => {
        expect(isPullRequestIssueComment({})).toBe(false);
    });
});

describe('groupCommentsByPullRequest', () => {
    it('groups both comment kinds under their pull request', () => {
        const grouped = groupCommentsByPullRequest(
            [reviewComment(10, 'src/a.ts'), reviewComment(11, 'src/b.ts')],
            [issueComment(10, 'pull')],
        );

        expect(grouped).toHaveLength(2);
        const ten = grouped.find((g) => g.pr.pull_number === 10);
        expect(ten.reviewComments).toHaveLength(1);
        expect(ten.generalComments).toHaveLength(1);
    });

    // The per-PR files request existed only to count extensions. Review
    // comments already carry the path, so the same data comes out at no extra
    // request -- that is one third of the old call volume removed.
    it('derives files from the paths review comments were left on', () => {
        const [entry] = groupCommentsByPullRequest(
            [
                reviewComment(7, 'src/app.ts'),
                reviewComment(7, 'src/util.ts'),
                reviewComment(7),
            ],
            [],
        );

        expect(entry.files).toEqual([
            { filename: 'src/app.ts' },
            { filename: 'src/util.ts' },
        ]);
    });

    it('leaves files empty when a PR has only conversation comments', () => {
        const [entry] = groupCommentsByPullRequest(
            [],
            [issueComment(3, 'pull')],
        );

        // Downstream reads this as "no language tag", the same as a files
        // fetch that failed -- not as an error.
        expect(entry.files).toEqual([]);
        expect(entry.generalComments).toHaveLength(1);
    });

    it('excludes issue comments from the grouping entirely', () => {
        const grouped = groupCommentsByPullRequest(
            [],
            [issueComment(3, 'pull'), issueComment(99, 'issues')],
        );

        expect(grouped.map((g) => g.pr.pull_number)).toEqual([3]);
    });

    it('skips comments whose url cannot be parsed', () => {
        const grouped = groupCommentsByPullRequest(
            [{ pull_request_url: undefined, path: 'src/a.ts' } as any],
            [],
        );

        expect(grouped).toEqual([]);
    });

    it('tolerates empty and missing inputs', () => {
        expect(groupCommentsByPullRequest([], [])).toEqual([]);
        expect(
            groupCommentsByPullRequest(undefined as any, undefined as any),
        ).toEqual([]);
    });
});
