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

import { DeleteIntegrationAndRepositoriesUseCase } from '../delete-integration-and-repositories.use-case';

const ORG = 'org-1';
const TEAM = 'team-1';

type Conn = { uuid: string; team?: string; repos: string[] };

const build = (connections: Conn[]) => {
    const inTeam = connections.filter((c) => (c.team ?? TEAM) === TEAM);
    const allRepos = [...new Set(inTeam.flatMap((c) => c.repos))];

    const deleteIntegrationUseCase = { execute: jest.fn() };
    const parametersService = {
        findOne: jest.fn().mockResolvedValue({
            configValue: {
                configs: { keep: true },
                repositories: allRepos.map((id) => ({ id, name: `r-${id}` })),
            },
        }),
    };
    const createOrUpdateParametersUseCase = { execute: jest.fn() };
    const pullRequestMessagesService = {
        find: jest.fn().mockResolvedValue([]),
        deleteByFilter: jest.fn(),
    };
    const kodyRulesService = {
        findByOrganizationId: jest.fn().mockResolvedValue(null),
        updateRulesStatusByFilter: jest.fn(),
    };
    const integrationService = {
        find: jest.fn(async () =>
            inTeam.map((c) => ({ uuid: c.uuid, platform: 'GITHUB' })),
        ),
    };
    const integrationConfigService = {
        findIntegrationConfigFormatted: jest.fn(
            async (_key: string, orgTeam: { integrationId?: string }) =>
                (
                    connections.find((c) => c.uuid === orgTeam.integrationId)
                        ?.repos ?? []
                ).map((id) => ({ id })),
        ),
        findByOrganizationAndConfigKey: jest.fn(async () =>
            connections.map((c) => ({
                integration: { uuid: c.uuid },
                configValue: c.repos.map((id) => ({ id })),
            })),
        ),
    };

    const useCase = new (DeleteIntegrationAndRepositoriesUseCase as any)(
        deleteIntegrationUseCase,
        parametersService,
        createOrUpdateParametersUseCase,
        pullRequestMessagesService,
        kodyRulesService,
        integrationService,
        integrationConfigService,
    ) as DeleteIntegrationAndRepositoriesUseCase;

    const deletedRepoIds = () =>
        pullRequestMessagesService.deleteByFilter.mock.calls.map(
            ([filter]) => filter.repositoryId,
        );

    return {
        useCase,
        deleteIntegrationUseCase,
        createOrUpdateParametersUseCase,
        deletedRepoIds,
    };
};

describe('DeleteIntegrationAndRepositoriesUseCase — one connection of several', () => {
    it('resets the named connection and cleans only its repositories', async () => {
        const {
            useCase,
            deleteIntegrationUseCase,
            createOrUpdateParametersUseCase,
            deletedRepoIds,
        } = build([
            { uuid: 'gh-a', repos: ['1', '2'] },
            { uuid: 'gl-b', repos: ['3'] },
        ]);

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(deleteIntegrationUseCase.execute).toHaveBeenCalledWith({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });
        expect(deletedRepoIds().sort()).toEqual(['1', '2']);
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            {
                configs: { keep: true },
                repositories: [{ id: '3', name: 'r-3' }],
            },
            { organizationId: ORG, teamId: TEAM },
        );
    });

    it('never cleans a repository another connection still lists', async () => {
        const { useCase, deletedRepoIds } = build([
            { uuid: 'gh-a', repos: ['1', '9'] },
            { uuid: 'gl-b', repos: ['2'] },
            { uuid: 'gl-x', team: 'team-2', repos: ['9'] },
        ]);

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(deletedRepoIds()).toEqual(['1']);
    });

    it("keeps the review settings of a repository another connection of the workspace still lists", async () => {
        const { useCase, createOrUpdateParametersUseCase } = build([
            { uuid: 'gh-a', repos: ['1', '5'] },
            { uuid: 'fj-b', repos: ['5'] },
        ]);

        await useCase.execute({
            organizationId: ORG,
            teamId: TEAM,
            connectionId: 'gh-a',
        });

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            {
                configs: { keep: true },
                repositories: [{ id: '5', name: 'r-5' }],
            },
            { organizationId: ORG, teamId: TEAM },
        );
    });

    it("keeps the rules and messages of a repository another workspace lists, on a workspace's only connection", async () => {
        const { useCase, deletedRepoIds } = build([
            { uuid: 'gh-a', repos: ['1', '9'] },
            { uuid: 'gh-x', team: 'team-2', repos: ['9'] },
        ]);

        await useCase.execute({ organizationId: ORG, teamId: TEAM });

        expect(deletedRepoIds()).toEqual(['1']);
    });

    it('asks which connection when the workspace has several and none is named, before touching anything', async () => {
        const { useCase, deleteIntegrationUseCase, deletedRepoIds } = build([
            { uuid: 'gh-a', repos: ['1'] },
            { uuid: 'gl-b', repos: ['2'] },
        ]);

        await expect(
            useCase.execute({ organizationId: ORG, teamId: TEAM }),
        ).rejects.toThrow(BadRequestException);
        expect(deleteIntegrationUseCase.execute).not.toHaveBeenCalled();
        expect(deletedRepoIds()).toEqual([]);
    });

    it('refuses a connection that is not in the workspace', async () => {
        const { useCase, deleteIntegrationUseCase } = build([
            { uuid: 'gh-a', repos: ['1'] },
        ]);

        await expect(
            useCase.execute({
                organizationId: ORG,
                teamId: TEAM,
                connectionId: 'elsewhere',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(deleteIntegrationUseCase.execute).not.toHaveBeenCalled();
    });
});
