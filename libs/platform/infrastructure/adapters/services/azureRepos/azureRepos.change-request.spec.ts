import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

import { AzureReposService } from './azureRepos.service';

const REASON = 'The critical findings behind this request are resolved.';
const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/api' },
    prNumber: 7,
    reason: REASON,
};
const NOTE = 'Kody takes this request back once the findings above are resolved.';

/** The service without its constructor: only what a test hands it. */
const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

const build = (state: PullRequestReviewState | null = null) => {
    const votePullRequest = jest.fn().mockResolvedValue({});
    const createSingleIssueComment = jest.fn().mockResolvedValue({ id: 55 });
    const service = make(AzureReposService, {
        getReviewStatusByPullRequest: jest.fn().mockResolvedValue(state),
        getAuthDetails: jest.fn().mockResolvedValue({ orgName: 'acme', token: 't' }),
        getProjectIdFromRepository: jest.fn().mockResolvedValue('p-1'),
        azureReposRequestHelper: {
            getAuthenticatedUserId: jest.fn().mockResolvedValue('me'),
            votePullRequest,
        },
        getListOfCriticalIssues: () => '- one critical issue',
        createSingleIssueComment,
    });
    return { service: service as any, votePullRequest, createSingleIssueComment };
};

describe('AzureReposService — Kody change request', () => {
    describe('dismissOwnPullRequestChangeRequests', () => {
        it('resets the reject vote Kody cast', async () => {
            const { service, votePullRequest } = build(
                PullRequestReviewState.CHANGES_REQUESTED,
            );

            expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(
                1,
            );
            expect(votePullRequest).toHaveBeenCalledTimes(1);
            expect(votePullRequest).toHaveBeenCalledWith({
                orgName: 'acme',
                token: 't',
                projectId: 'p-1',
                repositoryId: 'repo-1',
                prId: 7,
                reviewerId: 'me',
                vote: 0,
            });
        });

        it.each([PullRequestReviewState.NONE, PullRequestReviewState.APPROVED])(
            'leaves the vote alone when Kody is not requesting changes (%s)',
            async (state) => {
                const { service, votePullRequest } = build(state);

                expect(
                    await service.dismissOwnPullRequestChangeRequests(params),
                ).toBe(0);
                expect(votePullRequest).not.toHaveBeenCalled();
            },
        );

        it('fails when the vote cannot be read', async () => {
            const { service, votePullRequest } = build(null);

            await expect(
                service.dismissOwnPullRequestChangeRequests(params),
            ).rejects.toThrow("Could not read Kody's vote on PR #7");
            expect(votePullRequest).not.toHaveBeenCalled();
        });

        it('still resets an approval through the same vote', async () => {
            const { service, votePullRequest } = build(
                PullRequestReviewState.APPROVED,
            );

            expect(await service.dismissOwnPullRequestApprovals(params)).toBe(1);
            expect(votePullRequest).toHaveBeenCalledWith(
                expect.objectContaining({ vote: 0, reviewerId: 'me' }),
            );
        });
    });

    describe('requestChangesPullRequest', () => {
        const request = {
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            prNumber: 7,
            criticalComments: [{}],
        };

        it('says how the request leaves and hands back the summary thread', async () => {
            const { service, createSingleIssueComment } = build();

            await expect(service.requestChangesPullRequest(request)).resolves.toEqual(
                { summaryCommentId: '55' },
            );
            expect(createSingleIssueComment).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 7,
                    body: `# Found critical issues, please review the requested changes\n\n- one critical issue\n\n${NOTE}`,
                }),
            );
        });

        it('answers true, as before, when the host hands back no thread', async () => {
            const { service, createSingleIssueComment } = build();
            createSingleIssueComment.mockResolvedValue(null);

            await expect(service.requestChangesPullRequest(request)).resolves.toBe(
                true,
            );
        });
    });
});
