import { ForbiddenException } from '@nestjs/common';

import { CodeManagementController } from './codeManagement.controller';
import { IntegrationController } from './integration.controller';
import { IntegrationConfigController } from './integrationConfig.controller';

/**
 * A member granted only some of the workspace's Git connections reads those
 * connections only: their names, repositories, members and hooks.
 */
const user = {
    uuid: 'u-1',
    role: 'contributor',
    organization: { uuid: 'org-1' },
};

const restricted = {
    restrictionFor: jest.fn().mockResolvedValue({
        connectionIds: new Set(['gh-a']),
        repositoryIds: new Set(['repo-gh']),
        allowsRepository: ({ id }: { id?: unknown }) => id === 'repo-gh',
    }),
};

const make = <T extends object>(
    Controller: { prototype: T },
    fields: Record<string, unknown>,
) => {
    const controller: any = Object.create(Controller.prototype);
    Object.assign(controller, {
        request: { user },
        connectionAccess: restricted,
        ...fields,
    });
    return controller;
};

describe('connection reads for a member granted some connections', () => {
    it('lists only the granted Git connections', async () => {
        const controller = make(IntegrationController, {
            getConnectionsUseCase: {
                execute: jest.fn().mockResolvedValue([
                    { connectionId: 'gh-a', category: 'CODE_MANAGEMENT' },
                    { connectionId: 'gl-b', category: 'CODE_MANAGEMENT' },
                    { connectionId: 'jira', category: 'PROJECT_MANAGEMENT' },
                ]),
            },
        });

        const connections = await controller.getConnections({ teamId: 't' });

        expect(
            connections.map((c: { connectionId: string }) => c.connectionId),
        ).toEqual(['gh-a', 'jira']);
    });

    it('lists the provider repositories of granted connections only', async () => {
        const execute = jest.fn().mockResolvedValue([]);
        const controller = make(CodeManagementController, {
            getRepositoriesUseCase: { execute },
        });

        await controller.getRepositories({ teamId: 't' });
        await expect(
            controller.getRepositories({ teamId: 't', connectionId: 'gl-b' }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ readableConnectionIds: ['gh-a'] }),
        );
    });

    it('reads the saved repositories of granted connections only', async () => {
        const execute = jest.fn().mockResolvedValue([]);
        const controller = make(IntegrationConfigController, {
            getIntegrationConfigsByIntegrationCategoryUseCase: { execute },
        });

        await controller.getIntegrationConfigsByIntegrationCategory(
            'CODE_MANAGEMENT',
            't',
        );
        await expect(
            controller.getIntegrationConfigsByIntegrationCategory(
                'CODE_MANAGEMENT',
                't',
                'gl-b',
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ readableConnectionIds: ['gh-a'] }),
        );
    });

    it('lists the members of a granted connection, and of the only one granted when none is named', async () => {
        const execute = jest
            .fn()
            .mockResolvedValue({ status: 'ok', members: [] });
        const controller = make(CodeManagementController, {
            getCodeManagementMemberListUseCase: { execute },
        });

        await controller.getOrganizationMembers({ teamId: 't' });
        await expect(
            controller.getOrganizationMembers({
                teamId: 't',
                connectionId: 'gl-b',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(execute).toHaveBeenCalledWith('t', {}, 'gh-a');
    });

    it("answers a hook status for the caller's organization and readable repositories only", async () => {
        const execute = jest.fn().mockResolvedValue({ active: true });
        const controller = make(CodeManagementController, {
            getWebhookStatusUseCase: { execute },
        });

        await controller.getWebhookStatus({
            organizationId: 'another-org',
            teamId: 't',
            repositoryId: 'repo-gh',
        });
        await expect(
            controller.getWebhookStatus({
                teamId: 't',
                repositoryId: 'repo-gl',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(execute).toHaveBeenCalledWith({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repositoryId: 'repo-gh',
        });
    });
});
