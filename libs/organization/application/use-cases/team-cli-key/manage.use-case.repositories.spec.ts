import { ManageTeamCliKeysUseCase } from './manage.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ManageTeamCliKeysUseCase and the key repo list (ADR-057)', () => {
    const key = {
        uuid: 'key-1',
        name: 'ci',
        active: true,
        team: { uuid: 'team-1' },
        config: { capabilities: ['runs:read'], repositoryIds: ['repo-1'] },
    };
    const setup = () => {
        const service = {
            findById: jest.fn().mockResolvedValue(key),
            findByTeamId: jest.fn().mockResolvedValue([key]),
            update: jest.fn().mockImplementation(async (_f, data) => ({ ...key, ...data })),
        };
        const uc = new ManageTeamCliKeysUseCase(
            service as any,
            { emit: jest.fn() } as any,
            { cliKeyChanged: jest.fn() } as any,
            { findOneOrganizationIdByTeamId: jest.fn().mockResolvedValue('org-1') } as any,
        );
        return { uc, service };
    };
    const actor = { uuid: 'u', organization: { uuid: 'org-1' } } as any;

    it('a capabilities edit keeps the repo list set by PUT /teams/:teamId/cli-keys/:keyId/repositories', async () => {
        const { uc, service } = setup();
        const res: any = await uc.execute({ action: 'update', teamId: 'team-1', keyId: 'key-1', body: { config: { capabilities: [] } } }, actor);
        expect(service.update).toHaveBeenCalledWith({ uuid: 'key-1' }, { config: { capabilities: [], repositoryIds: ['repo-1'] } });
        expect(res.config).toEqual({ capabilities: [], repositoryIds: ['repo-1'] });
    });

    it("a capabilities edit cannot write the repo list: only its own route, which checks each repository against the team, may", async () => {
        const { uc, service } = setup();
        await uc.execute(
            { action: 'update', teamId: 'team-1', keyId: 'key-1', body: { config: { capabilities: ['runs:read'], repositoryIds: ['repo-of-another-team'] } } },
            actor,
        );
        expect(service.update).toHaveBeenCalledWith({ uuid: 'key-1' }, { config: { capabilities: ['runs:read'], repositoryIds: ['repo-1'] } });
    });

    it('a new key starts with no repo list, whatever the create body says', async () => {
        const { uc, service } = setup();
        (service as any).generateKey = jest.fn().mockResolvedValue({ key: 'kodus_x', uuid: 'key-2' });
        await uc.execute({ action: 'generate', teamId: 'team-1', body: { name: 'ci', config: { capabilities: ['runs:read'], repositoryIds: ['repo-of-another-team'] } } } as any, actor);
        expect((service as any).generateKey).toHaveBeenCalledWith('team-1', 'ci', 'u', { capabilities: ['runs:read'] });
    });

    it('lists the repo list with the capabilities', async () => {
        const { uc } = setup();
        const [listed]: any = await uc.execute({ action: 'list', teamId: 'team-1' }, actor);
        expect(listed.config).toEqual({ capabilities: ['runs:read'], repositoryIds: ['repo-1'] });
    });
});
