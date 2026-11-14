import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

import { BitbucketDataCenterService } from './bitbucket-data-center.service';

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

const build = (
    state: PullRequestReviewState | null,
    over: Record<string, unknown> = {},
) => {
    const put = jest.fn().mockResolvedValue({});
    const service = make(BitbucketDataCenterService, {
        getReviewStatusByPullRequest: jest.fn().mockResolvedValue(state),
        getAuthDetails: jest.fn().mockResolvedValue({ username: 'token-name' }),
        getRepoConfig: jest
            .fn()
            .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' }),
        // The participant requestChangesPullRequest marked NEEDS_WORK.
        getCurrentUser: jest.fn().mockResolvedValue({ id: 'kody' }),
        getAxiosInstance: () => ({ put }),
        ...over,
    });
    return { service: service as any, put };
};

describe('BitbucketDataCenterService.dismissOwnPullRequestChangeRequests', () => {
    it('sets the participant it marked NEEDS_WORK back to UNAPPROVED', async () => {
        const { service, put } = build(PullRequestReviewState.CHANGES_REQUESTED);

        expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(1);
        expect(put).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledWith(
            '/projects/PRJ/repos/api/pull-requests/7/participants/kody',
            { user: { name: 'kody' }, status: 'UNAPPROVED' },
        );
    });

    it.each([PullRequestReviewState.NONE, PullRequestReviewState.APPROVED])(
        'leaves the PR alone when Kody is not requesting changes (%s)',
        async (state) => {
            const { service, put } = build(state);

            expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(
                0,
            );
            expect(put).not.toHaveBeenCalled();
        },
    );

    it('fails when the state of the request cannot be read', async () => {
        const { service, put } = build(null);

        await expect(
            service.dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow("Could not read Kody's change request on PR #7");
        expect(put).not.toHaveBeenCalled();
    });

    it.each([
        ['auth details', { getAuthDetails: jest.fn().mockResolvedValue(null) }],
        ['repository', { getRepoConfig: jest.fn().mockResolvedValue(null) }],
        ['token user', { getCurrentUser: jest.fn().mockResolvedValue(null) }],
    ])('fails without the %s', async (_name, over) => {
        const { service, put } = build(
            PullRequestReviewState.CHANGES_REQUESTED,
            over,
        );

        await expect(
            service.dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow('Bitbucket Data Center repository not found');
        expect(put).not.toHaveBeenCalled();
    });

    it('looks the repository up by name when it has no id', async () => {
        const getRepoConfig = jest
            .fn()
            .mockResolvedValue({ workspaceId: 'PRJ', name: 'api' });
        const { service } = build(PullRequestReviewState.CHANGES_REQUESTED, {
            getRepoConfig,
        });

        await service.dismissOwnPullRequestChangeRequests({
            ...params,
            repository: { name: 'acme/api' },
        });

        expect(getRepoConfig).toHaveBeenCalledWith(
            params.organizationAndTeamData,
            'acme/api',
        );
    });
});
