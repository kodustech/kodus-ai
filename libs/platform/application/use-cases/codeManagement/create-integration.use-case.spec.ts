import { BadRequestException } from '@nestjs/common';

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

const build = (opts: { existingConnection?: unknown } = {}) => {
    const codeManagementService = {
        createAuthIntegration: jest.fn().mockResolvedValue({
            success: true,
            status: 'SUCCESS',
            integrationId: 'new-conn',
        }),
    };
    const integrationService = {
        findOne: jest.fn().mockResolvedValue(opts.existingConnection),
        update: jest.fn().mockResolvedValue(undefined),
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
    );
    return { useCase, codeManagementService, integrationService };
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
});
