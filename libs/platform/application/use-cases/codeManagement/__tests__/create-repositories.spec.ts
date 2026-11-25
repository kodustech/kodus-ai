import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CreateRepositoriesUseCase } from '../create-repositories';

const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

const build = (
    overrides: {
        persistedRepoIds?: Array<{ id: string | number }>;
        selection?: { mode: 'manual' | 'all' } | null;
        request?: unknown;
    } = {},
) => {
    const teamService = {
        findById: jest.fn().mockResolvedValue({
            uuid: 'team-1',
            status: STATUS.ACTIVE,
        }),
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
    };

    const codeManagementService = {
        createOrUpdateIntegrationConfig: jest.fn().mockResolvedValue(undefined),
        getTypeIntegration: jest.fn().mockResolvedValue('github'),
    };

    const integrationConfigService = {
        findIntegrationConfigFormatted: jest.fn(async (key: string) =>
            key === IntegrationConfigKey.REPOSITORY_SELECTION
                ? (overrides.selection ?? null)
                : (overrides.persistedRepoIds ?? []),
        ),
    };

    const repositoryConnectionService = {
        startHistoricalBackfill: jest.fn().mockReturnValue(true),
        registerRepositoryRecords: jest.fn(async ({ repositories }) =>
            repositories.map((repository: { id: string }) => ({
                repository,
                record: { uuid: `rec-${repository.id}` },
            })),
        ),
        enqueueAstBuild: jest.fn().mockResolvedValue(true),
    };

    const useCase = new CreateRepositoriesUseCase(
        teamService as any,
        {} as any,
        { execute: jest.fn().mockResolvedValue([]) } as any,
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        codeManagementService as any,
        { execute: jest.fn().mockResolvedValue(undefined) } as any,
        integrationConfigService as any,
        repositoryConnectionService as any,
        overrides.request as any,
        {
            repositoryConnected: jest.fn(),
            repositoriesSelected: jest.fn(),
        } as any,
    );

    return { useCase, codeManagementService, repositoryConnectionService };
};

describe('CreateRepositoriesUseCase', () => {
    it('uses the explicit organizationId when request.user is not available', async () => {
        const { useCase, codeManagementService } = build({ request: {} });

        await useCase.execute({
            organizationId: 'org-1',
            repositories: [
                {
                    id: 'repo-1',
                    name: 'alpha',
                    organizationName: 'kodus',
                    selected: true,
                },
            ],
            teamId: 'team-1',
            type: 'replace',
        });

        expect(
            codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalledWith({
            configKey: 'repositories',
            configValue: [
                {
                    id: 'repo-1',
                    name: 'alpha',
                    organizationName: 'kodus',
                    selected: true,
                },
            ],
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            type: 'replace',
        });
    });

    it('does not crash when request itself is undefined', async () => {
        const { useCase } = build();

        await expect(
            useCase.execute({
                organizationId: 'org-1',
                repositories: [],
                teamId: 'team-1',
                type: 'replace',
            }),
        ).resolves.toEqual({ status: true });
    });

    it('returns the expected validation error when request is undefined and no organizationId is provided', async () => {
        const { useCase } = build();

        await expect(
            useCase.execute({
                repositories: [],
                teamId: 'team-1',
                type: 'replace',
            }),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                message: 'Organization ID is required.',
            }),
        });
    });

    it('backfills only newly-added repos, skipping already-persisted ones', async () => {
        const { useCase, repositoryConnectionService } = build({
            persistedRepoIds: [{ id: 'repo-existing' }],
        });

        await useCase.execute({
            organizationId: 'org-1',
            teamId: 'team-1',
            type: 'replace',
            repositories: [
                { id: 'repo-existing', name: 'alpha', organizationName: 'kodus' },
                { id: 'repo-new', name: 'beta', organizationName: 'kodus' },
            ],
        });

        expect(
            repositoryConnectionService.startHistoricalBackfill,
        ).toHaveBeenCalledTimes(1);
        const [, passed] =
            repositoryConnectionService.startHistoricalBackfill.mock.calls[0];
        expect(passed.map((r: { id: string }) => r.id)).toEqual(['repo-new']);
    });

    it('does not backfill at all when every repo was already persisted', async () => {
        const { useCase, repositoryConnectionService } = build({
            persistedRepoIds: [{ id: 'repo-existing' }],
        });

        await useCase.execute({
            organizationId: 'org-1',
            teamId: 'team-1',
            type: 'replace',
            repositories: [
                { id: 'repo-existing', name: 'alpha', organizationName: 'kodus' },
            ],
        });

        expect(
            repositoryConnectionService.startHistoricalBackfill,
        ).not.toHaveBeenCalled();
    });

    it('registers every saved repository and enqueues its AST build', async () => {
        const { useCase, repositoryConnectionService } = build();

        await useCase.execute({
            organizationId: 'org-1',
            teamId: 'team-1',
            type: 'replace',
            repositories: [
                { id: 'a', name: 'alpha', organizationName: 'kodus' },
                { id: 'b', name: 'beta', organizationName: 'kodus' },
            ],
        });
        await flushSetImmediate();
        await flushSetImmediate();

        expect(
            repositoryConnectionService.registerRepositoryRecords,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                platform: 'github',
            }),
        );
        expect(repositoryConnectionService.enqueueAstBuild).toHaveBeenCalledTimes(
            2,
        );
    });

    describe('when the team reviews all repositories', () => {
        it('rejects a save that would remove a repository', async () => {
            const { useCase, codeManagementService } = build({
                selection: { mode: 'all' },
                persistedRepoIds: [{ id: 'a' }, { id: 'b' }],
            });

            await expect(
                useCase.execute({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    type: 'replace',
                    repositories: [{ id: 'a', name: 'alpha' }],
                }),
            ).rejects.toBeDefined();
            expect(
                codeManagementService.createOrUpdateIntegrationConfig,
            ).not.toHaveBeenCalled();
        });

        it('rejects the partial first chunk of a chunked save too', async () => {
            const { useCase } = build({
                selection: { mode: 'all' },
                persistedRepoIds: [{ id: 'a' }, { id: 'b' }],
            });

            await expect(
                useCase.execute({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    type: 'replace',
                    deferWebhooks: true,
                    repositories: [{ id: 'a', name: 'alpha' }],
                }),
            ).rejects.toBeDefined();
        });

        it('accepts a save that only adds repositories', async () => {
            const { useCase, codeManagementService } = build({
                selection: { mode: 'all' },
                persistedRepoIds: [{ id: 'a' }],
            });

            await useCase.execute({
                organizationId: 'org-1',
                teamId: 'team-1',
                type: 'replace',
                repositories: [
                    { id: 'a', name: 'alpha' },
                    { id: 'b', name: 'beta' },
                ],
            });

            expect(
                codeManagementService.createOrUpdateIntegrationConfig,
            ).toHaveBeenCalled();
        });

        it('lets a manual team remove repositories as before', async () => {
            const { useCase, codeManagementService } = build({
                selection: { mode: 'manual' },
                persistedRepoIds: [{ id: 'a' }, { id: 'b' }],
            });

            await useCase.execute({
                organizationId: 'org-1',
                teamId: 'team-1',
                type: 'replace',
                repositories: [{ id: 'a', name: 'alpha' }],
            });

            expect(
                codeManagementService.createOrUpdateIntegrationConfig,
            ).toHaveBeenCalled();
        });
    });
});
