import { TeamMemberService } from './teamMembers.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('TeamMemberService — Git connection access', () => {
    const build = () => {
        const runner = { query: jest.fn() };
        // Runs `alsoWithin` the way the repository runs it inside the insert.
        const repo = {
            create: jest.fn(
                async (
                    member: unknown,
                    options?: { alsoWithin?: (r: unknown) => Promise<void> },
                ) => {
                    await options?.alsoWithin?.(runner);
                    return member;
                },
            ),
        };
        const connectionAccess = {
            grantWorkspaceConnectionsWithin: jest
                .fn()
                .mockResolvedValue(undefined),
            forgetUsers: jest.fn(),
        };
        const service = new TeamMemberService(
            repo as any,
            {} as any,
            {} as any,
            connectionAccess as any,
        );
        return { service, repo, connectionAccess, runner };
    };

    it("grants a member joining a workspace that workspace's Git connections inside the member's insert", async () => {
        const { service, connectionAccess, runner } = build();

        await service.create({
            user: { uuid: 'user-1' },
            team: { uuid: 'team-1' },
            organization: { uuid: 'org-1' },
        } as any);

        expect(
            connectionAccess.grantWorkspaceConnectionsWithin.mock.calls,
        ).toEqual([[runner, 'user-1', 'team-1']]);
        expect(connectionAccess.forgetUsers.mock.calls).toEqual([[['user-1']]]);
        expect(
            connectionAccess.forgetUsers.mock.invocationCallOrder[0],
        ).toBeGreaterThan(
            connectionAccess.grantWorkspaceConnectionsWithin.mock
                .invocationCallOrder[0],
        );
    });

    it('fails when the member and their grants could not be written, so no invitation claims success', async () => {
        const { service, repo, connectionAccess } = build();
        // The repository answers a failed insert with the error, rolled back.
        repo.create.mockResolvedValueOnce(new Error('grant write failed'));

        await expect(
            service.create({
                user: { uuid: 'user-1' },
                team: { uuid: 'team-1' },
                organization: { uuid: 'org-1' },
            } as any),
        ).rejects.toThrow('grant write failed');
        expect(connectionAccess.forgetUsers.mock.calls).toEqual([[['user-1']]]);
    });

    it('grants nothing for a member row without a user', async () => {
        const { service, repo, connectionAccess } = build();

        await service.create({ team: { uuid: 'team-1' } } as any);

        expect(repo.create.mock.calls).toEqual([
            [{ team: { uuid: 'team-1' } }],
        ]);
        expect(
            connectionAccess.grantWorkspaceConnectionsWithin,
        ).not.toHaveBeenCalled();
    });
});
