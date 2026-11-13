import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

import {
    OWN_CHANGE_REQUEST_WITHDRAWN_REASON,
    OwnChangeRequestService,
} from './own-change-request.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('OwnChangeRequestService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: 'repo-1', name: 'acme/api' };
    const request = { organizationAndTeamData, repository, prNumber: 7 };
    const marked = (
        provider = PlatformType.GITHUB,
        changeRequest: Record<string, unknown> = {},
    ) => ({
        number: 7,
        provider,
        repository,
        kodyChangeRequest: {
            requestedAt: '2026-11-11T17:23:13.000Z',
            commentIds: ['11'],
            ...changeRequest,
        },
    });

    const build = (
        status: PullRequestReviewState | null = PullRequestReviewState.CHANGES_REQUESTED,
    ) => {
        const codeManagement = {
            getReviewStatusByPullRequest: jest.fn().mockResolvedValue(status),
            getPullRequestReviewThreads: jest
                .fn()
                .mockResolvedValue([{ fullDatabaseId: 11, isResolved: true }]),
            getPullRequestReviewComments: jest
                .fn()
                .mockResolvedValue([{ id: 11, isResolved: true }]),
            dismissOwnPullRequestChangeRequests: jest.fn().mockResolvedValue(1),
            markReviewCommentAsResolved: jest.fn().mockResolvedValue({}),
        };
        const pullRequests = {
            recordKodyChangeRequest: jest.fn().mockResolvedValue(true),
            clearKodyChangeRequest: jest.fn().mockResolvedValue(true),
            findOpenPullRequestsWithKodyChangeRequest: jest
                .fn()
                .mockImplementation(async () => [marked()]),
        };
        const isReviewRunning = jest.fn().mockResolvedValue(false);
        const service = new OwnChangeRequestService(
            codeManagement as any,
            pullRequests as any,
        );
        const run = (pullRequest: ReturnType<typeof marked> = marked()) =>
            service.withdrawIfResolved({
                organizationAndTeamData,
                pullRequest: pullRequest as any,
                isReviewRunning,
            });
        return { service, codeManagement, pullRequests, isReviewRunning, run };
    };

    const expectKept = ({
        codeManagement,
        pullRequests,
    }: ReturnType<typeof build>) => {
        expect(
            codeManagement.dismissOwnPullRequestChangeRequests,
        ).not.toHaveBeenCalled();
        expect(
            codeManagement.markReviewCommentAsResolved,
        ).not.toHaveBeenCalled();
        expect(pullRequests.clearKodyChangeRequest).not.toHaveBeenCalled();
    };

    describe('withdrawIfResolved', () => {
        it('withdraws a request whose findings are resolved, then forgets it', async () => {
            const built = build();

            await expect(built.run()).resolves.toBe(true);

            expect(
                built.codeManagement.dismissOwnPullRequestChangeRequests,
            ).toHaveBeenCalledWith(
                { ...request, reason: OWN_CHANGE_REQUEST_WITHDRAWN_REASON },
                PlatformType.GITHUB,
            );
            expect(
                built.pullRequests.clearKodyChangeRequest,
            ).toHaveBeenCalledWith(
                'org-1',
                'repo-1',
                7,
                '2026-11-11T17:23:13.000Z',
            );
        });

        it.each([
            PullRequestReviewState.APPROVED,
            PullRequestReviewState.DISMISSED,
        ])(
            'forgets a request the host no longer shows, dismissing nothing (%s)',
            async (status) => {
                const built = build(status);

                await expect(built.run()).resolves.toBe(false);

                expect(
                    built.pullRequests.clearKodyChangeRequest,
                ).toHaveBeenCalledTimes(1);
                expect(
                    built.codeManagement.dismissOwnPullRequestChangeRequests,
                ).not.toHaveBeenCalled();
            },
        );

        // Kody approved since: the vote is gone, the summary thread is not.
        it('still resolves the summary of a request the host no longer shows', async () => {
            const built = build(PullRequestReviewState.APPROVED);
            const pullRequest = marked(PlatformType.AZURE_REPOS, {
                summaryCommentIds: ['77'],
            });
            built.codeManagement.getPullRequestReviewComments.mockResolvedValue(
                [{ threadId: 11, isResolved: true }],
            );
            built.pullRequests.findOpenPullRequestsWithKodyChangeRequest.mockResolvedValue(
                [pullRequest],
            );

            await expect(built.run(pullRequest)).resolves.toBe(true);

            expect(
                built.codeManagement.dismissOwnPullRequestChangeRequests,
            ).not.toHaveBeenCalled();
            expect(
                built.codeManagement.markReviewCommentAsResolved,
            ).toHaveBeenCalledWith(
                { ...request, commentId: '77' },
                PlatformType.AZURE_REPOS,
            );
            expect(
                built.pullRequests.clearKodyChangeRequest,
            ).toHaveBeenCalledTimes(1);
        });

        // Nothing on record to check the request against is not "all resolved".
        it.each([[[]], [undefined]])(
            'keeps a request with no comment on record (%p)',
            async (commentIds) => {
                const built = build();

                await expect(
                    built.run(marked(PlatformType.GITHUB, { commentIds })),
                ).resolves.toBe(false);
                expectKept(built);
            },
        );

        it('keeps the request when the host does not answer its state', async () => {
            const built = build(null);

            await expect(built.run()).resolves.toBe(false);
            expectKept(built);
        });

        it('keeps the request while a finding behind it is open', async () => {
            const built = build();
            built.codeManagement.getPullRequestReviewThreads.mockResolvedValue([
                { fullDatabaseId: 11, isResolved: false },
            ]);

            await expect(built.run()).resolves.toBe(false);
            expectKept(built);
            expect(built.isReviewRunning).not.toHaveBeenCalled();
            // The comments are all the host is asked for while one is open.
            expect(
                built.codeManagement.getReviewStatusByPullRequest,
            ).not.toHaveBeenCalled();
        });

        it('keeps the request when the host does not answer with its comments', async () => {
            const built = build();
            built.codeManagement.getPullRequestReviewThreads.mockResolvedValue(
                null,
            );

            await expect(built.run()).resolves.toBe(false);
            expectKept(built);
        });

        it('keeps the request while a review of the PR is running', async () => {
            const built = build();
            built.isReviewRunning.mockResolvedValue(true);

            await expect(built.run()).resolves.toBe(false);
            expectKept(built);
        });

        // A review that finished meanwhile requested changes again, over a
        // finding this reading of the request does not hold.
        it('keeps a request made again since it was read', async () => {
            const built = build();
            built.pullRequests.findOpenPullRequestsWithKodyChangeRequest.mockResolvedValue(
                [
                    marked(PlatformType.GITHUB, {
                        requestedAt: '2026-11-11T19:44:00.000Z',
                        commentIds: ['11', '12'],
                    }),
                ],
            );

            await expect(built.run()).resolves.toBe(false);
            expectKept(built);
        });

        it.each([
            ['another PR of the repository', { number: 8 }],
            [
                'the same number in another repository',
                { repository: { id: 'repo-2', name: 'acme/web' } },
            ],
        ])(
            'does not take %s, requested at the same instant, for this request',
            async (_name, over) => {
                const built = build();
                built.pullRequests.findOpenPullRequestsWithKodyChangeRequest.mockResolvedValue(
                    [{ ...marked(), ...over }],
                );

                await expect(built.run()).resolves.toBe(false);
                expectKept(built);
            },
        );

        it('asks the list of the same organization whether the request still stands', async () => {
            const built = build();

            await built.run();

            expect(
                built.pullRequests.findOpenPullRequestsWithKodyChangeRequest,
            ).toHaveBeenCalledWith('org-1');
        });

        it('keeps the request, on record too, when the host refuses to withdraw it', async () => {
            const built = build();
            const refused = new Error('403');
            built.codeManagement.dismissOwnPullRequestChangeRequests.mockRejectedValue(
                refused,
            );

            await expect(built.run()).rejects.toBe(refused);
            expect(
                built.pullRequests.clearKodyChangeRequest,
            ).not.toHaveBeenCalled();
        });

        it('resolves the summary the host kept open next to the request', async () => {
            const built = build();
            const pullRequest = marked(PlatformType.AZURE_REPOS, {
                summaryCommentIds: ['77'],
            });
            built.codeManagement.getPullRequestReviewComments.mockResolvedValue(
                [{ threadId: 11, isResolved: true }],
            );
            built.pullRequests.findOpenPullRequestsWithKodyChangeRequest.mockResolvedValue(
                [pullRequest],
            );

            await expect(built.run(pullRequest)).resolves.toBe(true);

            expect(
                built.codeManagement.dismissOwnPullRequestChangeRequests,
            ).toHaveBeenCalledTimes(1);
            expect(
                built.codeManagement.markReviewCommentAsResolved,
            ).toHaveBeenCalledWith(
                { ...request, commentId: '77' },
                PlatformType.AZURE_REPOS,
            );
        });

        // GitLab keeps no review state: the request there is the summary
        // discussion, which blocks where every thread must be resolved.
        it('on GitLab resolves the summary discussion, asking for no review state', async () => {
            const built = build();
            const pullRequest = marked(PlatformType.GITLAB, {
                summaryCommentIds: ['d-1'],
            });
            built.pullRequests.findOpenPullRequestsWithKodyChangeRequest.mockResolvedValue(
                [pullRequest],
            );

            await expect(built.run(pullRequest)).resolves.toBe(true);

            expect(
                built.codeManagement.getReviewStatusByPullRequest,
            ).not.toHaveBeenCalled();
            expect(
                built.codeManagement.dismissOwnPullRequestChangeRequests,
            ).not.toHaveBeenCalled();
            expect(
                built.codeManagement.getPullRequestReviewComments,
            ).toHaveBeenCalledWith(request, PlatformType.GITLAB);
            expect(
                built.codeManagement.markReviewCommentAsResolved,
            ).toHaveBeenCalledWith(
                { ...request, commentId: 'd-1' },
                PlatformType.GITLAB,
            );
            expect(
                built.pullRequests.clearKodyChangeRequest,
            ).toHaveBeenCalledTimes(1);
        });
    });

    describe('record', () => {
        beforeEach(() => {
            jest.useFakeTimers().setSystemTime(
                new Date('2026-11-11T17:23:13.000Z'),
            );
        });
        afterEach(() => jest.useRealTimers());

        it('writes the request with its comments and the summary the host left', async () => {
            const { service, pullRequests } = build();

            await service.record({
                ...request,
                commentIds: ['11', '12'],
                summaryCommentId: 'd-1',
            });

            expect(pullRequests.recordKodyChangeRequest).toHaveBeenCalledWith(
                'org-1',
                'repo-1',
                7,
                {
                    requestedAt: '2026-11-11T17:23:13.000Z',
                    commentIds: ['11', '12'],
                    summaryCommentId: 'd-1',
                },
            );
        });

        it('writes nothing for a request with no comment to check it against', async () => {
            const { service, pullRequests } = build();

            await service.record({ ...request, commentIds: [] });

            expect(pullRequests.recordKodyChangeRequest).not.toHaveBeenCalled();
        });
    });
});
