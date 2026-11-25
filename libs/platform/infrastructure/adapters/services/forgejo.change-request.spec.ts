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

import { ForgejoService } from './forgejo.service';

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

const build = (over: Record<string, unknown> = {}) =>
    make(ForgejoService, {
        getAuthDetails: jest.fn().mockResolvedValue({}),
        extractRepoInfo: () => ({ owner: 'acme', repo: 'api' }),
        createForgejoClient: () => ({}),
        paginate: async (fetchPage: (p: number, l: number) => unknown) =>
            fetchPage(1, 50),
        ...over,
    }) as any;

const reviews = (data: unknown[]) =>
    jest.mocked(repoListPullReviews).mockResolvedValue({ data } as any);

describe('ForgejoService — dismissing its own reviews', () => {
    beforeEach(() => {
        jest.mocked(repoDismissPullReview).mockReset();
        jest.mocked(userGetCurrent).mockResolvedValue({ data: { id: 1 } } as any);
        jest.mocked(repoDismissPullReview).mockResolvedValue({ data: {} } as any);
    });

    it('dismisses only the token user’s live change requests, with the reason', async () => {
        reviews([
            { id: 10, state: 'REQUEST_CHANGES', user: { id: 1 } },
            { id: 11, state: 'REQUEST_CHANGES', user: { id: 2 } },
            { id: 12, state: 'REQUEST_CHANGES', user: { id: 1 }, dismissed: true },
            { id: 13, state: 'APPROVED', user: { id: 1 } },
            { state: 'REQUEST_CHANGES', user: { id: 1 } },
        ]);

        expect(await build().dismissOwnPullRequestChangeRequests(params)).toBe(1);
        expect(repoDismissPullReview).toHaveBeenCalledTimes(1);
        const call = jest.mocked(repoDismissPullReview).mock.calls[0][0];
        expect(call.path).toEqual({ owner: 'acme', repo: 'api', index: 7, id: 10 });
        expect(call.body).toEqual({ message: REASON });
    });

    it('still dismisses approvals, and only approvals, with its own message', async () => {
        reviews([
            { id: 10, state: 'REQUEST_CHANGES', user: { id: 1 } },
            { id: 13, state: 'APPROVED', user: { id: 1 } },
        ]);

        expect(await build().dismissOwnPullRequestApprovals(params)).toBe(1);
        const call = jest.mocked(repoDismissPullReview).mock.calls[0][0];
        expect(call.path).toEqual(expect.objectContaining({ id: 13 }));
        expect(call.body).toEqual({
            message: 'Kody held automatic approval after a new review.',
        });
    });

    it.each([
        ['dismissOwnPullRequestChangeRequests', 'REQUEST_CHANGES', 'change request'],
        ['dismissOwnPullRequestApprovals', 'APPROVED', 'approval'],
    ])(
        '%s says the token user must be a repository admin when Forgejo refuses',
        async (method, state, what) => {
            reviews([{ id: 10, state, user: { id: 1 } }]);
            // The SDK returns the AxiosError itself when it does not throw.
            jest.mocked(repoDismissPullReview).mockResolvedValue({
                isAxiosError: true,
                error: { message: 'Must be repo admin' },
                response: { status: 403 },
            } as any);

            await expect(build()[method](params)).rejects.toThrow(
                `Forgejo refused to dismiss Kody's ${what} on PR #7: the token user must be an admin of acme/api.`,
            );
        },
    );

    it('fails when a dismissal fails for another reason', async () => {
        reviews([{ id: 10, state: 'REQUEST_CHANGES', user: { id: 1 } }]);
        jest.mocked(repoDismissPullReview).mockResolvedValue({
            error: { message: 'gone' },
        } as any);

        await expect(
            build().dismissOwnPullRequestChangeRequests(params),
        ).rejects.toEqual({ message: 'gone' });
    });

    it.each([
        ['auth details', { getAuthDetails: jest.fn().mockResolvedValue(null) }, 'No auth details'],
        ['a valid repository name', { extractRepoInfo: () => null }, 'Invalid repository name'],
    ])('fails without %s', async (_name, over, message) => {
        await expect(
            build(over).dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow(message);
        expect(repoDismissPullReview).not.toHaveBeenCalled();
    });

    it('fails when the token user cannot be identified', async () => {
        reviews([{ id: 10, state: 'REQUEST_CHANGES', user: { id: 1 } }]);
        jest.mocked(userGetCurrent).mockResolvedValue({ data: {} } as any);

        await expect(
            build().dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow('Unable to identify the token user');
    });
});
