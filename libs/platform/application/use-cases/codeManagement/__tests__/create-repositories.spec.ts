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
});
