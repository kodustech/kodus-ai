import { BadRequestException, ConflictException } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { CreateRepositoriesUseCase } from '../create-repositories';

type Connection = {
    uuid: string;
    platform: PlatformType;
    name?: string;
    host?: string;
    teamId?: string;
    repos?: string[];
};

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (connections: Connection[]) => {
    const inTeam = connections.filter((c) => (c.teamId ?? TEAM) === TEAM);
    const entity = (c: Connection) => ({
        uuid: c.uuid,
        platform: c.platform,
        name: c.name,
        team: { uuid: c.teamId ?? TEAM },
        authIntegration: { authDetails: c.host ? { host: c.host } : {} },
    });

    const integrationService = {
        findOne: jest.fn(async (filter: any) => {
            const c = inTeam.find((x) => x.uuid === filter.uuid);
            return c && entity(c);
        }),
        find: jest.fn(async () => connections.map(entity)),
        resolveCodeManagementConnection: jest.fn(async () =>
            inTeam.length === 1
                ? {
                      integration: entity(inTeam[0]),
                      platform: inTeam[0].platform,
                      ambiguous: false,
                  }
                : {
                      integration: undefined,
                      platform: null,
                      ambiguous: inTeam.length > 1,
                  },
        ),
    };

    const integrationConfigService = {
        findIntegrationConfigFormatted: jest.fn(
            async (key: string, orgTeam: { integrationId?: string }) => {
                if (key !== IntegrationConfigKey.REPOSITORIES) return null;
                const c = connections.find(
                    (x) => x.uuid === orgTeam.integrationId,
                );
                return (c?.repos ?? []).map((id) => ({ id }));
            },
        ),
        findByOrganizationAndConfigKey: jest.fn(async () =>
            connections.map((c) => ({
                configValue: (c.repos ?? []).map((id) => ({ id })),
                integration: { uuid: c.uuid },
                team: { uuid: c.teamId ?? TEAM },
            })),
        ),
    };

    const codeManagementService = {
        createOrUpdateIntegrationConfig: jest.fn().mockResolvedValue(undefined),
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
    };

    const useCase = new CreateRepositoriesUseCase(
        {
            findById: jest
                .fn()
                .mockResolvedValue({ uuid: TEAM, status: STATUS.ACTIVE }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        } as any,
        {} as any,
        { execute: jest.fn().mockResolvedValue([]) } as any,
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        codeManagementService as any,
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        integrationConfigService as any,
        {
            startHistoricalBackfill: jest.fn(),
            registerRepositoryRecords: jest.fn().mockResolvedValue([]),
            enqueueAstBuild: jest.fn(),
        } as any,
        { user: { organization: { uuid: ORG }, uuid: 'user-1' } } as any,
        {
            repositoryConnected: jest.fn(),
            repositoriesSelected: jest.fn(),
        } as any,
        integrationService as any,
    );

    return { useCase, codeManagementService };
};

const save = (
    useCase: CreateRepositoriesUseCase,
    ids: string[],
    connectionId?: string,
) =>
    useCase.execute({
        teamId: TEAM,
        connectionId,
        type: 'replace',
        repositories: ids.map((id) => ({ id, name: `repo-${id}` })),
    });

describe('CreateRepositoriesUseCase — Git connections', () => {
    it('saves the selection on the connection the caller names', async () => {
        const { useCase, codeManagementService } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB },
            { uuid: 'gl-b', platform: PlatformType.GITLAB },
        ]);

        await save(useCase, ['7'], 'gl-b');

        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: ORG,
                    teamId: TEAM,
                    integrationId: 'gl-b',
                },
            }),
        );
    });

    it('saves on the only connection when none is named', async () => {
        const { useCase, codeManagementService } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB },
        ]);

        await save(useCase, ['7']);

        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: expect.objectContaining({
                    integrationId: 'gh-a',
                }),
            }),
        );
    });

    it('asks which connection when the workspace has several and none is named', async () => {
        const { useCase, codeManagementService } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB },
            { uuid: 'gl-b', platform: PlatformType.GITLAB },
        ]);

        await expect(save(useCase, ['7'])).rejects.toThrow(BadRequestException);
        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).not.toHaveBeenCalled();
    });

    it('refuses a connection that is not in the workspace', async () => {
        const { useCase } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB },
            { uuid: 'other', platform: PlatformType.GITHUB, teamId: 'team-2' },
        ]);

        await expect(save(useCase, ['7'], 'other')).rejects.toThrow(
            BadRequestException,
        );
    });

    it('refuses a repository another connection on the same server already lists, naming it in the same workspace', async () => {
        const { useCase, codeManagementService } = build([
            {
                uuid: 'gh-a',
                platform: PlatformType.GITHUB,
                name: 'Acme',
                repos: ['7'],
            },
            { uuid: 'gh-b', platform: PlatformType.GITHUB },
        ]);

        const attempt = save(useCase, ['7'], 'gh-b');

        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.toThrow(/Acme/);
        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).not.toHaveBeenCalled();
    });

    it('does not name a connection that lives in another workspace', async () => {
        const { useCase } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB },
            {
                uuid: 'gh-x',
                platform: PlatformType.GITHUB,
                name: 'Secret client',
                teamId: 'team-2',
                repos: ['7'],
            },
        ]);

        const attempt = save(useCase, ['7'], 'gh-a');

        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.not.toThrow(/Secret client/);
    });

    it('allows the same id on another server', async () => {
        const { useCase, codeManagementService } = build([
            { uuid: 'gl-cloud', platform: PlatformType.GITLAB, repos: ['7'] },
            {
                uuid: 'gl-self',
                platform: PlatformType.GITLAB,
                host: 'https://git.acme.io',
            },
        ]);

        await save(useCase, ['7'], 'gl-self');

        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalled();
    });

    it('leaves a repository alone that the connection already listed', async () => {
        const { useCase, codeManagementService } = build([
            { uuid: 'gh-a', platform: PlatformType.GITHUB, repos: ['7'] },
            { uuid: 'gh-b', platform: PlatformType.GITHUB, repos: ['7'] },
        ]);

        await save(useCase, ['7'], 'gh-b');

        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalled();
    });
});
