jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { BadRequestException } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { DeleteIntegrationUseCase } from '../delete-integration.use-case';

const ORG = 'org-1';
const TEAM = 'team-1';

type Conn = { uuid: string; team?: string; repos?: string[] };

const build = (opts: {
    connections: Conn[];
    centralizedRepositoryId?: string;
}) => {
    const entity = (c: Conn) => ({
        uuid: c.uuid,
        platform: 'GITHUB',
        authIntegration: { uuid: `auth-${c.uuid}`, authDetails: {} },
    });
    const inTeam = opts.connections.filter((c) => (c.team ?? TEAM) === TEAM);

    const integrationService = {
        findOne: jest.fn(async (filter: any) => {
            const c = inTeam.find((x) => x.uuid === filter.uuid);
            return c && entity(c);
        }),
        find: jest.fn(async (filter: any) =>
            (filter?.team ? inTeam : opts.connections).map(entity),
        ),
        delete: jest.fn(),
    };
    const integrationConfigService = {
        find: jest.fn(async (filter: any) => {
            const c = opts.connections.find(
                (x) => x.uuid === filter?.integration?.uuid,
            );
            return [
                {
                    uuid: `cfg-${c?.uuid}`,
                    configKey: 'repositories',
                    configValue: (c?.repos ?? []).map((id) => ({ id })),
                },
            ];
        }),
        delete: jest.fn(),
    };
    const codeManagementService = { deleteWebhook: jest.fn() };
    const mcpManagerService = { deleteConnectionByIntegrationId: jest.fn() };
    const createOrUpdateParametersUseCase = { execute: jest.fn() };
    const parametersService = {
        findByKey: jest.fn(async () =>
            opts.centralizedRepositoryId
                ? {
                      configValue: {
                          enabled: true,
                          repository: { id: opts.centralizedRepositoryId },
                      },
                  }
                : null,
        ),
    };

    const useCase = new (DeleteIntegrationUseCase as any)(
        codeManagementService,
        integrationService,
        { delete: jest.fn() },
        integrationConfigService,
        createOrUpdateParametersUseCase,
        { emit: jest.fn() },
        mcpManagerService,
        { user: { uuid: 'user-1', email: 'owner@example.test' } },
        parametersService,
    ) as DeleteIntegrationUseCase;

    return {
        useCase,
        integrationService,
        codeManagementService,
        mcpManagerService,
        createOrUpdateParametersUseCase,
    };
};

describe('DeleteIntegrationUseCase — one connection of several', () => {
    it('resets only the connection the caller names', async () => {
        const { useCase, integrationService, codeManagementService } = build({
            connections: [{ uuid: 'gh-a' }, { uuid: 'gh-b' }],
        });

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-b',
        });

        expect(integrationService.delete).toHaveBeenCalledTimes(1);
        expect(integrationService.delete).toHaveBeenCalledWith('gh-b');
        expect(codeManagementService.deleteWebhook).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: ORG,
                teamId: TEAM,
                integrationId: 'gh-b',
            },
        });
    });

    it('asks which connection when the workspace has several and none is named', async () => {
        const { useCase, integrationService } = build({
            connections: [{ uuid: 'gh-a' }, { uuid: 'gh-b' }],
        });

        await expect(
            useCase.execute({ organizationId: ORG, teamId: TEAM }),
        ).rejects.toThrow(BadRequestException);
        expect(integrationService.delete).not.toHaveBeenCalled();
    });

    it('keeps the organization’s issues connection while another Git connection remains', async () => {
        const { useCase, mcpManagerService } = build({
            connections: [{ uuid: 'gh-a' }, { uuid: 'gl-x', team: 'team-2' }],
        });

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(
            mcpManagerService.deleteConnectionByIntegrationId,
        ).not.toHaveBeenCalled();
    });

    it('removes the issues connection with the organization’s last Git connection', async () => {
        const { useCase, mcpManagerService } = build({
            connections: [{ uuid: 'gh-a' }],
        });

        await useCase.execute({ organizationId: ORG, teamId: TEAM });

        expect(
            mcpManagerService.deleteConnectionByIntegrationId,
        ).toHaveBeenCalled();
    });

    it('keeps centralized config that lives on another connection', async () => {
        const { useCase, createOrUpdateParametersUseCase } = build({
            connections: [
                { uuid: 'gh-a', repos: ['1'] },
                { uuid: 'gh-b', repos: ['config-repo'] },
            ],
            centralizedRepositoryId: 'config-repo',
        });

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(
            createOrUpdateParametersUseCase.execute,
        ).not.toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            expect.anything(),
            expect.anything(),
        );
    });

    it('turns centralized config off when its repository goes with the connection', async () => {
        const { useCase, createOrUpdateParametersUseCase } = build({
            connections: [
                { uuid: 'gh-a', repos: ['config-repo'] },
                { uuid: 'gh-b', repos: ['2'] },
            ],
            centralizedRepositoryId: 'config-repo',
        });

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            expect.objectContaining({ enabled: false }),
            { organizationId: ORG, teamId: TEAM },
        );
    });
});
