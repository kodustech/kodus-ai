import { BitbucketCloudService } from './bitbucket-cloud.service';

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

const target = { pull_request_id: 7, repo_slug: '{repo-1}', workspace: '{ws}' };

const build = (participants: unknown, uuid = '{me}') => {
    const deleteChangeRequest = jest.fn().mockResolvedValue({});
    const get = jest.fn().mockResolvedValue({ data: { participants } });
    const getWorkspaceFromRepository = jest.fn().mockResolvedValue('ws');
    const service = make(BitbucketCloudService, {
        getWorkspaceFromRepository,
        getAuthDetails: jest.fn().mockResolvedValue({}),
        instanceBitbucketApi: () => ({
            users: {
                getAuthedUser: jest.fn().mockResolvedValue({ data: { uuid } }),
            },
            pullrequests: { get, deleteChangeRequest },
        }),
    });
    return {
        service: service as any,
        get,
        deleteChangeRequest,
        getWorkspaceFromRepository,
    };
};

describe('BitbucketCloudService.dismissOwnPullRequestChangeRequests', () => {
    it('withdraws the request while the PR shows Kody requesting changes', async () => {
        const { service, get, deleteChangeRequest } = build([
            { user: { uuid: '{other}' }, state: 'approved' },
            { user: { uuid: '{me}' }, state: 'changes_requested' },
        ]);

        expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(1);
        expect(get).toHaveBeenCalledWith(target);
        expect(deleteChangeRequest).toHaveBeenCalledTimes(1);
        expect(deleteChangeRequest).toHaveBeenCalledWith(target);
    });

    it.each([
        ['Kody approved', [{ user: { uuid: '{me}' }, state: 'approved' }]],
        ['Kody has no state', [{ user: { uuid: '{me}' }, state: null }]],
        [
            'somebody else requests changes',
            [{ user: { uuid: '{other}' }, state: 'changes_requested' }],
        ],
        ['a participant has no user', [{ state: 'changes_requested' }]],
        ['the PR lists no participants', undefined],
    ])('withdraws nothing when %s', async (_name, participants) => {
        const { service, deleteChangeRequest } = build(participants);

        expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(0);
        expect(deleteChangeRequest).not.toHaveBeenCalled();
    });

    it('fails when the token user cannot be identified', async () => {
        const { service, deleteChangeRequest } = build(
            [{ user: { uuid: '{me}' }, state: 'changes_requested' }],
            '',
        );

        await expect(
            service.dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow("Could not read Kody's change request on PR #7");
        expect(deleteChangeRequest).not.toHaveBeenCalled();
    });

    it('fails when the repository has no workspace', async () => {
        const { service, get, getWorkspaceFromRepository } = build([]);
        getWorkspaceFromRepository.mockResolvedValue(null);

        await expect(
            service.dismissOwnPullRequestChangeRequests(params),
        ).rejects.toThrow('Bitbucket workspace not found');
        expect(get).not.toHaveBeenCalled();
    });
});
