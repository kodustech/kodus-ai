jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    userGetCurrent: jest.fn(),
    repoListPullReviews: jest.fn(),
    repoDismissPullReview: jest.fn(),
}));

import {
    repoDismissPullReview,
    repoListPullReviews,
    userGetCurrent,
} from '@llamaduck/forgejo-ts';

import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { BitbucketService } from './bitbucket.service';
import { ForgejoService } from './forgejo.service';
import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';

/**
 * When a later review holds approval, the PR must not stay approved by Kody
 * under an "approval held" note. Each host removes only the token user's own
 * approval and reports how many it removed.
 */
const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/api' },
    prNumber: 7,
    reason: 'The PR changes a team-marked sensitive path.',
};

const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    for (const [key, value] of Object.entries(overrides)) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

describe.each([
    {
        host: 'Bitbucket Cloud',
        build: (state: PullRequestReviewState | null) => {
            const deleteApproval = jest.fn().mockResolvedValue({});
            const service = make(BitbucketCloudService, {
                getReviewStatusByPullRequest: jest.fn().mockResolvedValue(state),
                getWorkspaceFromRepository: jest.fn().mockResolvedValue('ws'),
                getAuthDetails: jest.fn().mockResolvedValue({}),
                instanceBitbucketApi: () => ({
                    pullrequests: { deleteApproval },
                }),
            });
            return {
                service,
                undo: deleteApproval,
                undoArgs: [
                    {
                        pull_request_id: 7,
                        repo_slug: '{repo-1}',
                        workspace: '{ws}',
                    },
                ],
            };
        },
    },
    {
        host: 'Bitbucket Data Center',
        build: (state: PullRequestReviewState | null) => {
            const put = jest.fn().mockResolvedValue({});
            const service = make(BitbucketDataCenterService, {
                getReviewStatusByPullRequest: jest.fn().mockResolvedValue(state),
                getAuthDetails: jest.fn().mockResolvedValue({ username: 'kody' }),
                getRepoConfig: jest
                    .fn()
                    .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' }),
                getAxiosInstance: () => ({ put }),
            });
            return {
                service,
                undo: put,
                undoArgs: [
                    '/projects/PRJ/repos/api/pull-requests/7/participants/kody',
                    { status: 'UNAPPROVED' },
                ],
            };
        },
    },
    {
        host: 'Azure Repos',
        build: (state: PullRequestReviewState | null) => {
            const votePullRequest = jest.fn().mockResolvedValue({});
            const service = make(AzureReposService, {
                getReviewStatusByPullRequest: jest.fn().mockResolvedValue(state),
                getAuthDetails: jest
                    .fn()
                    .mockResolvedValue({ orgName: 'acme', token: 't' }),
                getProjectIdFromRepository: jest.fn().mockResolvedValue('p-1'),
                azureReposRequestHelper: {
                    getAuthenticatedUserId: jest.fn().mockResolvedValue('me'),
                    votePullRequest,
                },
            });
            return {
                service,
                undo: votePullRequest,
                undoArgs: [
                    expect.objectContaining({
                        projectId: 'p-1',
                        repositoryId: 'repo-1',
                        prId: 7,
                        reviewerId: 'me',
                        vote: 0,
                    }),
                ],
            };
        },
    },
])('$host — dismissOwnPullRequestApprovals', ({ build }) => {
    it('removes the approval Kody gave', async () => {
        const { service, undo, undoArgs } = build(
            PullRequestReviewState.APPROVED,
        );
        expect(
            await (service as any).dismissOwnPullRequestApprovals(params),
        ).toBe(1);
        expect(undo).toHaveBeenCalledTimes(1);
        expect(undo).toHaveBeenCalledWith(...undoArgs);
    });

    it('leaves the PR alone when Kody has not approved it', async () => {
        const { service, undo } = build(PullRequestReviewState.NONE);
        expect(
            await (service as any).dismissOwnPullRequestApprovals(params),
        ).toBe(0);
        expect(undo).not.toHaveBeenCalled();
    });

    it('fails when Kody approval state cannot be read', async () => {
        const { service, undo } = build(null);
        await expect(
            (service as any).dismissOwnPullRequestApprovals(params),
        ).rejects.toThrow();
        expect(undo).not.toHaveBeenCalled();
    });
});

describe('Forgejo — dismissOwnPullRequestApprovals', () => {
    const build = () =>
        make(ForgejoService, {
            getAuthDetails: jest.fn().mockResolvedValue({}),
            extractRepoInfo: () => ({ owner: 'acme', repo: 'api' }),
            createForgejoClient: () => ({}),
            paginate: async (fetchPage: (p: number, l: number) => unknown) =>
                fetchPage(1, 50),
        });

    beforeEach(() => {
        jest.mocked(userGetCurrent).mockResolvedValue({ data: { id: 1 } } as any);
        jest.mocked(repoDismissPullReview).mockResolvedValue({ data: {} } as any);
    });

    it('dismisses only the token user’s live approvals', async () => {
        jest.mocked(repoListPullReviews).mockResolvedValue({
            data: [
                { id: 10, state: 'APPROVED', user: { id: 1 } },
                { id: 11, state: 'APPROVED', user: { id: 2 } },
                { id: 12, state: 'APPROVED', user: { id: 1 }, dismissed: true },
                { id: 13, state: 'COMMENT', user: { id: 1 } },
            ],
        } as any);

        expect(
            await (build() as any).dismissOwnPullRequestApprovals(params),
        ).toBe(1);
        expect(repoDismissPullReview).toHaveBeenCalledTimes(1);
        expect(jest.mocked(repoDismissPullReview).mock.calls[0][0].path).toEqual(
            expect.objectContaining({ index: 7, id: 10 }),
        );
    });

    it('says the token user must be a repository admin when Forgejo refuses', async () => {
        jest.mocked(repoListPullReviews).mockResolvedValue({
            data: [{ id: 10, state: 'APPROVED', user: { id: 1 } }],
        } as any);
        jest.mocked(repoDismissPullReview).mockResolvedValue({
            error: { message: 'Must be repo admin' },
            response: { status: 403 },
        } as any);

        await expect(
            (build() as any).dismissOwnPullRequestApprovals(params),
        ).rejects.toThrow('must be an admin of acme/api');
    });

    it('fails when a dismissal fails', async () => {
        jest.mocked(repoListPullReviews).mockResolvedValue({
            data: [{ id: 10, state: 'APPROVED', user: { id: 1 } }],
        } as any);
        jest.mocked(repoDismissPullReview).mockResolvedValue({
            error: { message: 'forbidden' },
        } as any);

        await expect(
            (build() as any).dismissOwnPullRequestApprovals(params),
        ).rejects.toBeTruthy();
    });
});

// The factory hands the stage whatever each host registered: a host whose
// registered service lacks the call (the Bitbucket wrapper did) dismisses
// nothing and the approval stays.
describe('every registered code management service', () => {
    it.each([
        ['GitHub', GithubService],
        ['GitLab', GitlabService],
        ['Bitbucket', BitbucketService],
        ['Azure Repos', AzureReposService],
        ['Forgejo', ForgejoService],
    ])('%s implements dismissOwnPullRequestApprovals', (_host, cls) => {
        expect(typeof cls.prototype.dismissOwnPullRequestApprovals).toBe(
            'function',
        );
    });

    it.each([
        ['Data Center', 'https://bitbucket.acme.test'],
        ['Cloud', ''],
    ])('the Bitbucket wrapper delegates to %s', async (_label, host) => {
        const cloud = { dismissOwnPullRequestApprovals: jest.fn().mockResolvedValue(1) };
        const dataCenter = {
            dismissOwnPullRequestApprovals: jest.fn().mockResolvedValue(1),
        };
        const service = make(BitbucketService, {
            bitbucketCloudService: cloud,
            bitbucketDataCenterService: dataCenter,
            integrationService: {
                getPlatformAuthDetails: jest.fn().mockResolvedValue({ host }),
            },
        });

        expect(await service.dismissOwnPullRequestApprovals(params)).toBe(1);
        const used = host ? dataCenter : cloud;
        const unused = host ? cloud : dataCenter;
        expect(used.dismissOwnPullRequestApprovals).toHaveBeenCalledWith(params);
        expect(unused.dismissOwnPullRequestApprovals).not.toHaveBeenCalled();
    });
});

// Kody approves on Data Center through /participants/{user}: a user who is not
// a designated reviewer is listed under `participants`, so the approval check
// must read that list too, or the approval is never seen and never dismissed.
describe('Bitbucket Data Center — reading Kody approval for dismissal', () => {
    const build = (pr: Record<string, unknown>) => {
        const put = jest.fn().mockResolvedValue({});
        const service = make(BitbucketDataCenterService, {
            getAuthDetails: jest.fn().mockResolvedValue({ username: 'kody' }),
            getRepoConfig: jest
                .fn()
                .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' }),
            getCurrentUser: jest.fn().mockResolvedValue({ id: 'kody' }),
            getAxiosInstance: () => ({
                get: jest.fn().mockResolvedValue({ data: pr }),
                put,
            }),
            logger: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
        });
        return { service, put };
    };

    it.each([
        ['a participant', { reviewers: [], participants: [{ user: { name: 'kody' }, status: 'APPROVED' }] }],
        ['a designated reviewer', { reviewers: [{ user: { name: 'kody' }, status: 'APPROVED' }], participants: [] }],
    ])('dismisses an approval Kody gave as %s', async (_label, pr) => {
        const { service, put } = build(pr);

        expect(await service.dismissOwnPullRequestApprovals(params)).toBe(1);
        expect(put).toHaveBeenCalledWith(
            '/projects/PRJ/repos/api/pull-requests/7/participants/kody',
            { status: 'UNAPPROVED' },
        );
    });
});
