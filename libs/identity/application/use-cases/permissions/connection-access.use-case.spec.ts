import { NotFoundException } from '@nestjs/common';

import { ConnectionAccessUseCase } from './connection-access.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (opts: { inWorkspace?: boolean; granted?: string[] } = {}) => {
    const service = {
        connectionInWorkspace: jest
            .fn()
            .mockResolvedValue(opts.inWorkspace ?? true),
        membersOfOrganization: jest.fn(async (_org: string, ids: string[]) =>
            ids.filter((id) => id !== 'stranger'),
        ),
        listGrants: jest.fn().mockResolvedValue(opts.granted ?? []),
        replaceGrants: jest.fn(async (_id: string, ids: string[]) => ({
            granted: ids.filter((id) => !(opts.granted ?? []).includes(id)),
            revoked: (opts.granted ?? []).filter((id) => !ids.includes(id)),
        })),
    };
    const useCase = new ConnectionAccessUseCase(
        service as any,
        { user: { uuid: 'owner-1', organization: { uuid: ORG } } } as any,
    );
    return { useCase, service };
};

describe('ConnectionAccessUseCase', () => {
    it('lists who may read a connection', async () => {
        const { useCase } = build({ granted: ['u1', 'u2'] });

        await expect(
            useCase.list({ teamId: TEAM, connectionId: 'conn-1' }),
        ).resolves.toEqual({ userIds: ['u1', 'u2'] });
    });

    it('replaces the set: grants the new members and revokes the dropped ones', async () => {
        const { useCase, service } = build({ granted: ['u1', 'u2'] });

        await useCase.replace({
            teamId: TEAM,
            connectionId: 'conn-1',
            userIds: ['u2', 'u3'],
        });

        expect(service.replaceGrants).toHaveBeenCalledWith('conn-1', [
            'u2',
            'u3',
        ]);
    });

    it('ignores users from outside the organization', async () => {
        const { useCase, service } = build({ granted: [] });

        await useCase.replace({
            teamId: TEAM,
            connectionId: 'conn-1',
            userIds: ['u3', 'stranger'],
        });

        expect(service.replaceGrants).toHaveBeenCalledWith('conn-1', ['u3']);
    });

    it('refuses a connection outside the caller’s workspace', async () => {
        const { useCase, service } = build({ inWorkspace: false });

        await expect(
            useCase.replace({
                teamId: TEAM,
                connectionId: 'other',
                userIds: ['u1'],
            }),
        ).rejects.toThrow(NotFoundException);
        expect(service.replaceGrants).not.toHaveBeenCalled();
    });
});
