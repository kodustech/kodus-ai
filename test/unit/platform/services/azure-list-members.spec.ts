import { AzureReposService } from '@libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

/**
 * Azure identifies principals by descriptor prefix: `aad.` / `msa.` are
 * people, `svc.` is a service identity such as a pipeline Build Service.
 * Those open pull requests like any other author, so typing them as users
 * left them without a bot badge and outside the seat-pruning shield.
 */
describe('AzureReposService.getListMembers', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const makeService = (members: unknown[]) => {
        const service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            { listOrganizationUsers: jest.fn().mockResolvedValue(members) } as any,
            {} as any,
            {} as any,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'acme',
            token: 'tok',
        });

        return service;
    };

    it('types a Build Service descriptor as a bot', async () => {
        const service = makeService([
            { descriptor: 'svc.YmJhMDI2', displayName: 'Proj Build Service (acme)' },
        ]);

        const members = await service.getListMembers({ organizationAndTeamData });

        expect(members).toEqual([
            {
                id: 'svc.YmJhMDI2',
                name: 'Proj Build Service (acme)',
                type: 'bot',
            },
        ]);
    });

    it('leaves a human principal typed as a user', async () => {
        const service = makeService([
            { descriptor: 'aad.MGRjZmU0', displayName: 'Dani Gomes' },
        ]);

        const members = await service.getListMembers({ organizationAndTeamData });

        expect(members[0]).toMatchObject({ type: 'user', name: 'Dani Gomes' });
    });
});
