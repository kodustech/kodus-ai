import { TeamMemberService } from './teamMembers.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('TeamMemberService — Git connection access', () => {
    const build = () => {
        const repo = {
            create: jest.fn(async (member: unknown) => member),
        };
        const connectionAccess = {
            grantWorkspaceConnections: jest.fn().mockResolvedValue(undefined),
        };
        const service = new TeamMemberService(
            repo as any,
            {} as any,
            {} as any,
            connectionAccess as any,
        );
        return { service, repo, connectionAccess };
    };

    it('grants a member joining a workspace that workspace’s Git connections', async () => {
        const { service, connectionAccess } = build();

        await service.create({
            user: { uuid: 'user-1' },
            team: { uuid: 'team-1' },
            organization: { uuid: 'org-1' },
        } as any);

        expect(connectionAccess.grantWorkspaceConnections).toHaveBeenCalledWith(
            'user-1',
            'team-1',
        );
    });

    it('grants nothing for a member row without a user', async () => {
        const { service, connectionAccess } = build();

        await service.create({ team: { uuid: 'team-1' } } as any);

        expect(
            connectionAccess.grantWorkspaceConnections,
        ).not.toHaveBeenCalled();
    });
});
