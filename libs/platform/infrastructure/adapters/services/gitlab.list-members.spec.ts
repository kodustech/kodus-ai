import { GitlabService } from './gitlab.service';

const make = (overrides: Record<string, unknown>) => {
    const service = Object.create(GitlabService.prototype) as GitlabService;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

describe('GitlabService.getListMembers', () => {
    it('answers no members for a connection with no repositories saved yet', async () => {
        const service = make({
            getAuthDetails: jest.fn().mockResolvedValue({ accessToken: 't' }),
            integrationService: {
                findOne: jest.fn().mockResolvedValue({ uuid: 'gl-b' }),
            },
            integrationConfigService: {
                findOne: jest.fn().mockResolvedValue(null),
            },
            instanceGitlabApi: jest.fn().mockReturnValue({
                Projects: { allUsers: jest.fn() },
            }),
        });

        await expect(
            service.getListMembers({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    integrationId: 'gl-b',
                },
            }),
        ).resolves.toEqual([]);
    });
});
