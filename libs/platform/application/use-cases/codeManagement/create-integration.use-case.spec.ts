import {
    BadRequestException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { CreateIntegrationUseCase } from './create-integration.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (
    opts: {
        existingConnection?: unknown;
        workspaceConnections?: Array<{ uuid: string; createdAt?: Date }>;
        bindPrimary?: boolean;
        centralized?: Record<string, unknown>;
    } = {},
) => {
    const parametersService = {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                opts.centralized
                    ? { configValue: opts.centralized }
                    : undefined,
            ),
        createOrUpdateConfig: jest.fn().mockResolvedValue(true),
    };
    const codeManagementService = {
        createAuthIntegration: jest.fn().mockResolvedValue({
            success: true,
            status: 'SUCCESS',
            integrationId: 'new-conn',
        }),
    };
    const integrationService = {
        findOne: jest.fn().mockResolvedValue(opts.existingConnection),
        find: jest.fn().mockResolvedValue(opts.workspaceConnections ?? []),
        update: jest.fn().mockResolvedValue(undefined),
    };
    const connectionBilling = {
        workspaceConnections: jest.fn(async () =>
            [...(opts.workspaceConnections ?? [])].sort(
                (a, b) =>
                    (a.createdAt?.getTime() ?? Infinity) -
                    (b.createdAt?.getTime() ?? Infinity),
            ),
        ),
        attributeLegacySeatsBeforeAdding: jest
            .fn()
            .mockResolvedValue(undefined),
        ensurePrimary: jest
            .fn()
            .mockResolvedValue(
                opts.bindPrimary === false
                    ? { status: 'failed' }
                    : { status: 'bound', primaryConnectionId: 'gh-a' },
            ),
    };
    const ignoreBots = {
        execute: jest.fn().mockResolvedValue(undefined),
        claimConnectionLists: jest.fn().mockResolvedValue(undefined),
    };
    const connectionAccess = {
        grantWorkspaceMembers: jest.fn().mockResolvedValue(['u-1']),
    };
    const useCase = new CreateIntegrationUseCase(
        codeManagementService as any,
        { emit: jest.fn() } as any,
        {
            user: {
                organization: { uuid: ORG },
                uuid: 'user-1',
                email: 'owner@example.test',
            },
        } as any,
        { findOne: jest.fn().mockResolvedValue(undefined) } as any,
        ignoreBots as any,
        { gitIntegrationChanged: jest.fn() } as any,
        integrationService as any,
        connectionBilling as any,
        connectionAccess as any,
        parametersService as any,
    );
    return {
        useCase,
        codeManagementService,
        integrationService,
        connectionBilling,
        connectionAccess,
        ignoreBots,
        parametersService,
    };
};

describe('CreateIntegrationUseCase — connections', () => {
    it('asks the provider for a new connection and names it', async () => {
        const { useCase, codeManagementService, integrationService } = build();

        const result = await useCase.execute({
            integrationType: 'github',
            newConnection: true,
            name: '  Client repos  ',
            organizationAndTeamData: { teamId: TEAM },
        });

        expect(
            codeManagementService.createAuthIntegration,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                newConnection: true,
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: TEAM,
                },
            }),
            'github',
        );
        expect(integrationService.update).toHaveBeenCalledWith(
            {
                uuid: 'new-conn',
                organization: { uuid: ORG },
                team: { uuid: TEAM },
            },
            { name: 'Client repos' },
        );
        expect(result.integrationId).toBe('new-conn');
    });

    it('reconnects the connection the caller names', async () => {
        const { useCase, codeManagementService } = build({
            existingConnection: { uuid: 'conn-2' },
        });

        await useCase.execute({
            integrationType: 'gitlab',
            connectionId: 'conn-2',
            organizationAndTeamData: { teamId: TEAM },
        });

        expect(
            codeManagementService.createAuthIntegration,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                newConnection: false,
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: TEAM,
                    integrationId: 'conn-2',
                },
            }),
            'gitlab',
        );
    });

    it('refuses a connection id that is not in the workspace', async () => {
        const { useCase, codeManagementService } = build({
            existingConnection: undefined,
        });

        await expect(
            useCase.execute({
                integrationType: 'gitlab',
                connectionId: 'someone-elses',
                organizationAndTeamData: { teamId: TEAM },
            }),
        ).rejects.toThrow(BadRequestException);
        expect(
            codeManagementService.createAuthIntegration,
        ).not.toHaveBeenCalled();
    });

    it('does not rename anything when no name is given', async () => {
        const { useCase, integrationService } = build();

        await useCase.execute({
            integrationType: 'github',
            newConnection: true,
            organizationAndTeamData: { teamId: TEAM },
        });

        expect(integrationService.update).not.toHaveBeenCalled();
    });

    describe('billing primary connection', () => {
        it('settles which connection keeps the plan before another is added', async () => {
            const { useCase, connectionBilling, codeManagementService } = build(
                {
                    workspaceConnections: [
                        { uuid: 'gl-b', createdAt: new Date('2026-03-01') },
                        { uuid: 'gh-a', createdAt: new Date('2025-01-01') },
                    ],
                },
            );

            await useCase.execute({
                integrationType: 'forgejo',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(connectionBilling.ensurePrimary).toHaveBeenCalledWith(
                { organizationId: ORG, teamId: TEAM },
                { beforeAddingConnection: true },
            );
            expect(
                connectionBilling.ensurePrimary.mock.invocationCallOrder[0],
            ).toBeLessThan(
                codeManagementService.createAuthIntegration.mock
                    .invocationCallOrder[0],
            );
        });

        it('refuses to add a connection while billing cannot record which one keeps the plan', async () => {
            const { useCase, codeManagementService } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
                bindPrimary: false,
            });

            await expect(
                useCase.execute({
                    integrationType: 'gitlab',
                    newConnection: true,
                    organizationAndTeamData: { teamId: TEAM },
                }),
            ).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(
                codeManagementService.createAuthIntegration,
            ).not.toHaveBeenCalled();
        });

        it('binds nothing for the first connection of a workspace or a reconnect', async () => {
            const first = build();
            await first.useCase.execute({
                integrationType: 'github',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            const reconnect = build({
                existingConnection: { uuid: 'gh-a' },
                workspaceConnections: [{ uuid: 'gh-a' }],
            });
            await reconnect.useCase.execute({
                integrationType: 'github',
                connectionId: 'gh-a',
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(
                first.connectionBilling.ensurePrimary,
            ).not.toHaveBeenCalled();
            expect(
                reconnect.connectionBilling.ensurePrimary,
            ).not.toHaveBeenCalled();
        });
    });

    describe('self-hosted seats from before connections', () => {
        it('are attributed before any new connection is created, never on a reconnect', async () => {
            const added = build({ workspaceConnections: [{ uuid: 'gh-a' }] });
            await added.useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });
            expect(
                added.connectionBilling.attributeLegacySeatsBeforeAdding,
            ).toHaveBeenCalledWith({ organizationId: ORG, teamId: TEAM });
            expect(
                added.connectionBilling.attributeLegacySeatsBeforeAdding.mock
                    .invocationCallOrder[0],
            ).toBeLessThan(
                added.codeManagementService.createAuthIntegration.mock
                    .invocationCallOrder[0],
            );

            const reconnect = build({
                existingConnection: { uuid: 'gh-a' },
                workspaceConnections: [{ uuid: 'gh-a' }],
            });
            await reconnect.useCase.execute({
                integrationType: 'github',
                connectionId: 'gh-a',
                organizationAndTeamData: { teamId: TEAM },
            });
            expect(
                reconnect.connectionBilling.attributeLegacySeatsBeforeAdding,
            ).not.toHaveBeenCalled();
        });
    });

    describe('who reads a new connection', () => {
        it("grants every workspace member the workspace's first connection, as before connections existed", async () => {
            const { useCase, connectionAccess } = build();

            await useCase.execute({
                integrationType: 'github',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(connectionAccess.grantWorkspaceMembers).toHaveBeenCalledWith(
                TEAM,
                'new-conn',
            );
        });

        it('starts a connection added beside others with owners only, and its own empty author lists', async () => {
            const { useCase, connectionAccess, ignoreBots } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
            });

            await useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(
                connectionAccess.grantWorkspaceMembers,
            ).not.toHaveBeenCalled();
            expect(ignoreBots.claimConnectionLists).toHaveBeenCalledWith({
                organizationId: ORG,
                integrationId: 'new-conn',
            });
            expect(
                ignoreBots.claimConnectionLists.mock.invocationCallOrder[0],
            ).toBeLessThan(ignoreBots.execute.mock.invocationCallOrder[0]);
        });

        it("leaves a reconnected connection's readers as they are", async () => {
            const { useCase, connectionAccess } = build({
                existingConnection: { uuid: 'gh-a' },
                workspaceConnections: [{ uuid: 'gh-a' }],
            });

            await useCase.execute({
                integrationType: 'github',
                connectionId: 'gh-a',
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(
                connectionAccess.grantWorkspaceMembers,
            ).not.toHaveBeenCalled();
        });
    });

    describe('PR author filters', () => {
        it("seeds a connection added beside others into that connection's own lists", async () => {
            const { useCase, ignoreBots } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
            });

            await useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(ignoreBots.execute).toHaveBeenCalledWith({
                organizationId: ORG,
                teamId: TEAM,
                integrationId: 'new-conn',
                separateConnection: true,
            });
        });

        it("seeds a workspace's first connection into the organization lists, as before", async () => {
            const { useCase, ignoreBots } = build();

            await useCase.execute({
                integrationType: 'github',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(ignoreBots.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    integrationId: 'new-conn',
                    separateConnection: false,
                }),
            );
        });
    });

    describe('centralized config', () => {
        it("records the workspace's centralized config as the existing connection's before another is added", async () => {
            const centralized = {
                enabled: true,
                repository: { id: 'r-1', name: 'acme/config' },
            };
            const { useCase, parametersService } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
                centralized,
            });

            await useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
                'centralized_config',
                centralized,
                { organizationId: ORG, teamId: TEAM, integrationId: 'gh-a' },
            );
        });

        it('records nothing for a centralized config that was never set up', async () => {
            const { useCase, parametersService } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
                centralized: { enabled: false, repository: null },
            });

            await useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(
                parametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });

        it('leaves a centralized config already recorded on a connection alone', async () => {
            const { useCase, parametersService } = build({
                workspaceConnections: [{ uuid: 'gh-a' }],
                centralized: {
                    enabled: true,
                    repository: null,
                    integrationId: 'gh-a',
                },
            });

            await useCase.execute({
                integrationType: 'gitlab',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(
                parametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });
    });
});
