import { BadRequestException } from '@nestjs/common';

import { CentralizedConfigConnectionScope } from './centralized-config-connection-scope.service';

const workspace = { organizationId: 'org-1', teamId: 'team-1' };

const build = (opts: {
    connections: Array<{ uuid: string; repos?: string[] }>;
    owner?: string;
    connectionScoped?: boolean;
}) => {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({
            configValue: {
                enabled: true,
                ...(opts.owner ? { integrationId: opts.owner } : {}),
                ...(opts.connectionScoped ? { connectionScoped: true } : {}),
            },
        }),
    };
    const scope = new CentralizedConfigConnectionScope(
        {
            find: jest
                .fn()
                .mockResolvedValue(
                    opts.connections.map(({ uuid }) => ({ uuid })),
                ),
        } as any,
        {
            findAllOfTeamByConfigKey: jest.fn().mockResolvedValue(
                opts.connections.map(({ uuid, repos }) => ({
                    integration: { uuid },
                    configValue: (repos ?? []).map((id) => ({ id })),
                })),
            ),
        } as any,
        parametersService as any,
    );
    return { scope, parametersService };
};

describe('CentralizedConfigConnectionScope', () => {
    it("puts a call that names no connection on the workspace config's connection", async () => {
        const { scope } = build({
            connections: [{ uuid: 'gh-a' }, { uuid: 'gl-b' }],
            owner: 'gl-b',
        });

        await expect(scope.workspaceConfigScope(workspace)).resolves.toEqual({
            ...workspace,
            integrationId: 'gl-b',
        });
    });

    it('leaves a single-connection workspace, or a named connection, as it is', async () => {
        const single = build({
            connections: [{ uuid: 'gh-a' }],
            owner: 'gh-a',
        });
        await expect(
            single.scope.workspaceConfigScope(workspace),
        ).resolves.toEqual(workspace);
        expect(single.parametersService.findByKey).not.toHaveBeenCalled();

        const named = build({
            connections: [{ uuid: 'gh-a' }, { uuid: 'gl-b' }],
            owner: 'gl-b',
        });
        await expect(
            named.scope.workspaceConfigScope({
                ...workspace,
                integrationId: 'gh-a',
            }),
        ).resolves.toEqual({ ...workspace, integrationId: 'gh-a' });
    });

    it("exports only the scoped connection's repositories, without the defaults for its own config", async () => {
        const { scope } = build({
            connections: [
                { uuid: 'gh-a', repos: ['1'] },
                { uuid: 'gl-b', repos: ['2'] },
            ],
            connectionScoped: true,
        });

        await expect(
            scope.downloadScope({ ...workspace, integrationId: 'gl-b' }),
        ).resolves.toEqual({
            repositoryIds: ['2'],
            includeWorkspaceDefaults: false,
        });
        await expect(scope.downloadScope(workspace)).resolves.toEqual({});
    });

    it('asks which connection when several and none is named, and refuses one outside the workspace', () => {
        const { scope } = build({ connections: [] });
        const connections = [
            { integrationId: 'gh-a', repositoryIds: [] },
            { integrationId: 'gl-b', repositoryIds: [] },
        ];

        expect(() => scope.scopeTo(workspace, connections)).toThrow(
            BadRequestException,
        );
        expect(() =>
            scope.scopeTo(workspace, connections, 'elsewhere'),
        ).toThrow(BadRequestException);
        expect(scope.scopeTo(workspace, connections, 'gl-b')).toEqual({
            ...workspace,
            integrationId: 'gl-b',
        });
    });
});
