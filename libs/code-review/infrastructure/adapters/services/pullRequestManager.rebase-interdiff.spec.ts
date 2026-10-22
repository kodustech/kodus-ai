import { PullRequestHandlerService } from './pullRequestManager.service';

/**
 * #2037: after a rebase, what is left to review is the current PR diff minus
 * the hunks that were already in the PR diff at the earlier head.
 */
describe('PullRequestHandlerService.getRebaseInterdiff', () => {
    const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { name: 'repo', id: 'repo-id' };
    const pullRequest = {
        number: 42,
        head: { sha: 'new-head' },
        base: { ref: 'main' },
    };

    const unchanged = { filename: 'src/same.ts', patch: '@@ -1 +1 @@\n-a\n+b' };
    const before = { filename: 'src/edited.ts', patch: '@@ -1 +1 @@\n-c\n+d' };
    const after = { filename: 'src/edited.ts', patch: '@@ -5 +5 @@\n-c\n+e' };

    const makeService = (previous: unknown[] | null, current: unknown[]) => {
        const codeManagementService = {
            getPullRequestFilesAtCommit: jest.fn().mockResolvedValue(previous),
            getFilesByPullRequestId: jest.fn().mockResolvedValue(current),
        };
        const service = new PullRequestHandlerService(
            codeManagementService as any,
            {} as any,
        );
        return { service, codeManagementService };
    };

    it('keeps only what changed since the earlier head', async () => {
        const { service, codeManagementService } = makeService(
            [unchanged, before],
            [unchanged, after],
        );

        const result = await service.getRebaseInterdiff(
            orgData,
            repository,
            pullRequest,
            'old-head',
        );

        expect(
            codeManagementService.getPullRequestFilesAtCommit,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            baseBranch: 'main',
            headSha: 'old-head',
        });
        // `-c` was already removed before the rebase; only `+e` is new.
        expect(result?.files).toEqual([
            expect.objectContaining({
                filename: 'src/edited.ts',
                patch: '@@ -5,0 +5 @@\n+e',
            }),
        ]);
        expect(result?.unchangedFiles).toEqual(['src/same.ts']);
    });

    it('returns null when the earlier diff is unavailable', async () => {
        const { service, codeManagementService } = makeService(null, [after]);

        await expect(
            service.getRebaseInterdiff(orgData, repository, pullRequest, 'old'),
        ).resolves.toBeNull();
        expect(
            codeManagementService.getFilesByPullRequestId,
        ).not.toHaveBeenCalled();
    });

    it('returns null when the current diff came back empty, so nothing is skipped by mistake', async () => {
        const { service } = makeService([before], []);

        await expect(
            service.getRebaseInterdiff(orgData, repository, pullRequest, 'old'),
        ).resolves.toBeNull();
    });
});
