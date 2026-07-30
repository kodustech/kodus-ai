import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CreateRepositoriesUseCase } from '../create-repositories';

describe('CreateRepositoriesUseCase', () => {
    it('uses the explicit organizationId when request.user is not available', async () => {
        const teamService = {
            findById: jest.fn().mockResolvedValue({
                uuid: 'team-1',
                status: STATUS.ACTIVE,
            }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        };

        const codeManagementService = {
            createOrUpdateIntegrationConfig: jest
                .fn()
                .mockResolvedValue(undefined),
        };

        const useCase = new CreateRepositoriesUseCase(
            teamService as any,
            {} as any,
            { execute: jest.fn().mockResolvedValue([]) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn() } as any,
            codeManagementService as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue([]),
            } as any,
            {
                findOrCreate: jest
                    .fn()
                    .mockResolvedValue({
                        uuid: 'r1',
                        astGraphStatus: 'pending',
                        defaultBranch: 'main',
                        fullName: 'kodus/alpha',
                        platform: 'github',
                    }),
            } as any,
            {} as any,
            { repositoryConnected: jest.fn() } as any,
        );

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
        const teamService = {
            findById: jest.fn().mockResolvedValue({
                uuid: 'team-1',
                status: STATUS.ACTIVE,
            }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        };

        const codeManagementService = {
            createOrUpdateIntegrationConfig: jest
                .fn()
                .mockResolvedValue(undefined),
        };

        const useCase = new CreateRepositoriesUseCase(
            teamService as any,
            {} as any,
            { execute: jest.fn().mockResolvedValue([]) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn() } as any,
            codeManagementService as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue([]),
            } as any,
            { findOrCreate: jest.fn() } as any,
            undefined as any,
            { repositoryConnected: jest.fn() } as any,
        );

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
        const teamService = {
            findById: jest.fn().mockResolvedValue({
                uuid: 'team-1',
                status: STATUS.ACTIVE,
            }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        };

        const useCase = new CreateRepositoriesUseCase(
            teamService as any,
            {} as any,
            { execute: jest.fn().mockResolvedValue([]) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn() } as any,
            {
                createOrUpdateIntegrationConfig: jest.fn(),
            } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue([]),
            } as any,
            { findOrCreate: jest.fn() } as any,
            undefined as any,
            { repositoryConnected: jest.fn() } as any,
        );

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

    const flushSetImmediate = () =>
        new Promise((resolve) => setImmediate(resolve));

    const buildUseCase = (overrides: {
        backfill: any;
        persistedRepoIds: Array<{ id: string | number }>;
    }) => {
        const teamService = {
            findById: jest.fn().mockResolvedValue({
                uuid: 'team-1',
                status: STATUS.ACTIVE,
            }),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
        };

        const codeManagementService = {
            createOrUpdateIntegrationConfig: jest
                .fn()
                .mockResolvedValue(undefined),
            getTypeIntegration: jest.fn().mockResolvedValue('github'),
        };

        return new CreateRepositoriesUseCase(
            teamService as any,
            { enqueue: jest.fn() } as any,
            {} as any,
            { execute: jest.fn().mockResolvedValue([]) } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            codeManagementService as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            overrides.backfill as any,
            {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue(overrides.persistedRepoIds),
            } as any,
            {
                findOrCreate: jest.fn().mockResolvedValue({
                    uuid: 'r',
                    astGraphStatus: 'ready',
                    defaultBranch: 'main',
                    fullName: 'kodus/x',
                    platform: 'github',
                    externalId: 'e',
                    name: 'x',
                }),
            } as any,
            undefined as any,
            { repositoryConnected: jest.fn() } as any,
        );
    };

    it('backfills only newly-added repos, skipping already-persisted ones', async () => {
        const backfill = { execute: jest.fn().mockResolvedValue(undefined) };
        const useCase = buildUseCase({
            backfill,
            persistedRepoIds: [{ id: 'repo-existing' }],
        });

        await useCase.execute({
            organizationId: 'org-1',
            // Unique teamId: the single-flight guard is module-level state
            // shared across tests, so reusing 'team-1' would collide with the
            // backfill key another test already registered.
            teamId: 'team-delta-a',
            type: 'replace',
            repositories: [
                { id: 'repo-existing', name: 'alpha', organizationName: 'kodus' },
                { id: 'repo-new', name: 'beta', organizationName: 'kodus' },
            ],
        });

        await flushSetImmediate();

        expect(backfill.execute).toHaveBeenCalledTimes(1);
        const passed = backfill.execute.mock.calls[0][0].repositories;
        expect(passed).toHaveLength(1);
        expect(passed[0].id).toBe('repo-new');
    });

    it('does not backfill at all when every repo was already persisted', async () => {
        const backfill = { execute: jest.fn().mockResolvedValue(undefined) };
        const useCase = buildUseCase({
            backfill,
            persistedRepoIds: [{ id: 'repo-existing' }],
        });

        await useCase.execute({
            organizationId: 'org-1',
            teamId: 'team-delta-b',
            type: 'replace',
            repositories: [
                { id: 'repo-existing', name: 'alpha', organizationName: 'kodus' },
            ],
        });

        await flushSetImmediate();

        expect(backfill.execute).not.toHaveBeenCalled();
    });
});
