import { BitbucketService } from './bitbucket.service';

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

describe('BitbucketService.dismissOwnPullRequestChangeRequests', () => {
    it('hands the call to the implementation in use for the organization', async () => {
        const implementation = {
            dismissOwnPullRequestChangeRequests: jest.fn().mockResolvedValue(1),
        };
        const getImplementation = jest.fn().mockResolvedValue(implementation);
        const service = make(BitbucketService, { getImplementation }) as any;

        expect(await service.dismissOwnPullRequestChangeRequests(params)).toBe(1);
        expect(getImplementation).toHaveBeenCalledWith(
            params.organizationAndTeamData,
        );
        expect(
            implementation.dismissOwnPullRequestChangeRequests,
        ).toHaveBeenCalledWith(params);
    });
});
