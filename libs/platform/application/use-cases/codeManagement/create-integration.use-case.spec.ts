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
    } = {},
) => {
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
    const licenseService = {
        bindPrimaryConnection: jest
            .fn()
            .mockResolvedValue(opts.bindPrimary ?? true),
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
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        { gitIntegrationChanged: jest.fn() } as any,
        integrationService as any,
        licenseService as any,
    );
    return {
        useCase,
        codeManagementService,
        integrationService,
        licenseService,
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
        it('binds the workspace connection that keeps the plan before another is added', async () => {
            const { useCase, licenseService, codeManagementService } = build({
                workspaceConnections: [
                    { uuid: 'gl-b', createdAt: new Date('2026-03-01') },
                    { uuid: 'gh-a', createdAt: new Date('2025-01-01') },
                ],
            });

            await useCase.execute({
                integrationType: 'forgejo',
                newConnection: true,
                organizationAndTeamData: { teamId: TEAM },
            });

            expect(licenseService.bindPrimaryConnection).toHaveBeenCalledWith(
                { organizationId: ORG, teamId: TEAM },
                'gh-a',
            );
            expect(
                licenseService.bindPrimaryConnection.mock.invocationCallOrder[0],
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
                first.licenseService.bindPrimaryConnection,
            ).not.toHaveBeenCalled();
            expect(
                reconnect.licenseService.bindPrimaryConnection,
            ).not.toHaveBeenCalled();
        });
    });
});
