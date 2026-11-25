import { GitlabService } from './gitlab.service';

/**
 * When a later review holds approval, the MR must not stay approved by Kody
 * under an "approval held" note. Only the token user's own approval is removed.
 */
describe('GitlabService — dismissOwnPullRequestApprovals', () => {
    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: '42', name: 'acme/api' },
        prNumber: 7,
        reason: 'The PR changes a team-marked sensitive path.',
    };

    const makeService = (approvedBy: Array<{ user: { id: number } }>) => {
        const service = Object.create(GitlabService.prototype) as GitlabService;
        const api = {
            MergeRequestApprovals: {
                showConfiguration: jest
                    .fn()
                    .mockResolvedValue({ approved_by: approvedBy }),
                unapprove: jest.fn().mockResolvedValue(undefined),
            },
            Users: { showCurrentUser: jest.fn().mockResolvedValue({ id: 1 }) },
        };
        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({});
        jest.spyOn(
            service as unknown as { instanceGitlabApi: () => unknown },
            'instanceGitlabApi',
        ).mockReturnValue(api);
        return { service, api };
    };

    it('removes the approval Kody gave', async () => {
        const { service, api } = makeService([
            { user: { id: 9 } },
            { user: { id: 1 } },
        ]);

        expect(await service.dismissOwnPullRequestApprovals(params)).toBe(1);
        expect(api.MergeRequestApprovals.unapprove).toHaveBeenCalledWith(
            '42',
            7,
        );
    });

    it('leaves the MR alone when Kody has not approved it', async () => {
        const { service, api } = makeService([{ user: { id: 9 } }]);

        expect(await service.dismissOwnPullRequestApprovals(params)).toBe(0);
        expect(api.MergeRequestApprovals.unapprove).not.toHaveBeenCalled();
    });

    it('fails when unapproving fails, so the review records it', async () => {
        const { service, api } = makeService([{ user: { id: 1 } }]);
        api.MergeRequestApprovals.unapprove.mockRejectedValue(
            new Error('403 Forbidden'),
        );

        await expect(
            service.dismissOwnPullRequestApprovals(params),
        ).rejects.toThrow('403');
    });
});
