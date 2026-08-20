import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * Regression test for "fix(platform): rethrow transient fetch failures
 * from getCommits swallow" (2026-07-29): getCommitsForPullRequestForCodeReview
 * swallowed EVERY error into `null` (worse than Azure's version, which at
 * least distinguished 429s), which upstream collapses to "PR has no
 * commits" — createLineComments then anchors zero inline comments and the
 * review ships with suggestionsCount.sent=0, reporting SUCCESS. Observed
 * LIVE in production, 2026-07-29, cloud bitbucket cell — this is the
 * platform the bug was actually caught on, and had zero test coverage of
 * any kind for this method before.
 *
 * A 429 or a transient network failure must now rethrow so callers can
 * tell a failed fetch apart from a genuinely empty commit list; a
 * non-transient error keeps the historical null contract.
 */
describe('BitbucketCloudService.getCommitsForPullRequestForCodeReview — transient-failure rethrow', () => {
    let service: BitbucketCloudService;
    let listCommits: jest.Mock;

    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { name: 'repo', id: 'repo-1' },
        prNumber: 42,
    };

    beforeEach(() => {
        service = new BitbucketCloudService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            undefined,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            token: 'fake-token',
        });
        jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
            id: 'repo-1',
            workspaceId: 'workspace-1',
        });

        listCommits = jest.fn();
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
            pullrequests: { listCommits },
        });
    });

    it('rethrows on a transient (undici) fetch failure instead of returning null', async () => {
        listCommits.mockRejectedValue(new TypeError('fetch failed'));

        await expect(
            service.getCommitsForPullRequestForCodeReview(params as any),
        ).rejects.toThrow('fetch failed');
    });

    it('rethrows on a 429', async () => {
        listCommits.mockRejectedValue({
            status: 429,
            message: 'Too Many Requests',
        });

        await expect(
            service.getCommitsForPullRequestForCodeReview(params as any),
        ).rejects.toMatchObject({ status: 429 });
    });

    it('still returns null (historical contract) for a non-transient error', async () => {
        listCommits.mockRejectedValue(new Error('Repository not found'));

        await expect(
            service.getCommitsForPullRequestForCodeReview(params as any),
        ).resolves.toBeNull();
    });
});
