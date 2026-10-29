import { Test, TestingModule } from '@nestjs/testing';
import { REQUEST } from '@nestjs/core';
import { GetSelectedRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/get-selected-repositories.use-case';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

describe('GetSelectedRepositoriesUseCase', () => {
    let useCase: GetSelectedRepositoriesUseCase;
    let mockIntegrationConfigService: any;
    let mockAuthorizationService: any;
    let mockRequest: any;

    const mockRepositories: Repositories[] = [
        {
            id: '1',
            name: 'repo-1',
            full_name: 'org/repo-1',
            http_url: 'https://github.com/org/repo-1',
            avatar_url: 'https://avatars.githubusercontent.com/u/123',
            organizationName: 'org',
            visibility: 'private',
            selected: true,
            default_branch: 'main',
            language: 'TypeScript',
        },
        {
            id: '2',
            name: 'repo-2',
            full_name: 'org/repo-2',
            http_url: 'https://github.com/org/repo-2',
            avatar_url: 'https://avatars.githubusercontent.com/u/123',
            organizationName: 'org',
            visibility: 'public',
            selected: true,
            default_branch: 'main',
            language: 'JavaScript',
        },
        {
            id: '3',
            name: 'repo-3',
            full_name: 'org/repo-3',
            http_url: 'https://github.com/org/repo-3',
            avatar_url: 'https://avatars.githubusercontent.com/u/123',
            organizationName: 'org',
            visibility: 'private',
            selected: true,
            default_branch: 'develop',
            language: 'Python',
        },
    ];

    beforeEach(async () => {
        mockIntegrationConfigService = {
            findIntegrationConfigFormatted: jest.fn(),
        };

        mockAuthorizationService = {
            getRepositoryScope: jest.fn(),
        };

        mockRequest = {
            user: {
                organization: {
                    uuid: 'org-uuid-123',
                },
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetSelectedRepositoriesUseCase,
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: AuthorizationService,
                    useValue: mockAuthorizationService,
                },
                {
                    provide: REQUEST,
                    useValue: mockRequest,
                },
            ],
        }).compile();

        useCase = module.get<GetSelectedRepositoriesUseCase>(
            GetSelectedRepositoriesUseCase,
        );
    });

    describe('execute', () => {
        it('should return all selected repositories when user has full access', async () => {
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                mockRepositories,
            );
            mockAuthorizationService.getRepositoryScope.mockResolvedValue(null);

            const result = await useCase.execute({ teamId: 'team-uuid-123' });

            expect(
                mockIntegrationConfigService.findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(IntegrationConfigKey.REPOSITORIES, {
                organizationId: 'org-uuid-123',
                teamId: 'team-uuid-123',
            });

            expect(
                mockAuthorizationService.getRepositoryScope,
            ).toHaveBeenCalledWith({
                user: mockRequest.user,
                action: Action.Read,
                resource: ResourceType.CodeReviewSettings,
            });

            expect(result).toEqual(mockRepositories);
            expect(result).toHaveLength(3);
        });

        it('should filter repositories by user permissions', async () => {
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                mockRepositories,
            );
            mockAuthorizationService.getRepositoryScope.mockResolvedValue([
                '1',
                '3',
            ]);

            const result = await useCase.execute({ teamId: 'team-uuid-123' });

            expect(result).toHaveLength(2);
            expect((result as Repositories[]).map((r) => r.id)).toEqual([
                '1',
                '3',
            ]);
        });

        it('should return empty array when no repositories are configured', async () => {
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                null,
            );
            mockAuthorizationService.getRepositoryScope.mockResolvedValue(null);

            const result = await useCase.execute({ teamId: 'team-uuid-123' });

            expect(result).toEqual([]);
        });

        it('should return empty array when repositories is not an array', async () => {
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                {},
            );
            mockAuthorizationService.getRepositoryScope.mockResolvedValue(null);

            const result = await useCase.execute({ teamId: 'team-uuid-123' });

            expect(result).toEqual([]);
        });

        it('should return empty array on error', async () => {
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockRejectedValue(
                new Error('Database error'),
            );

            const result = await useCase.execute({ teamId: 'team-uuid-123' });

            expect(result).toEqual([]);
        });

        describe('pagination', () => {
            it('should return paginated results when page and perPage are provided', async () => {
                mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                    mockRepositories,
                );
                mockAuthorizationService.getRepositoryScope.mockResolvedValue(
                    null,
                );

                const result = await useCase.execute({
                    teamId: 'team-uuid-123',
                    page: 1,
                    perPage: 2,
                });

                expect(result).toEqual({
                    data: mockRepositories.slice(0, 2),
                    pagination: {
                        page: 1,
                        perPage: 2,
                        total: 3,
                    },
                });
            });

            it('should return second page correctly', async () => {
                mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                    mockRepositories,
                );
                mockAuthorizationService.getRepositoryScope.mockResolvedValue(
                    null,
                );

                const result = await useCase.execute({
                    teamId: 'team-uuid-123',
                    page: 2,
                    perPage: 2,
                });

                expect(result).toEqual({
                    data: [mockRepositories[2]],
                    pagination: {
                        page: 2,
                        perPage: 2,
                        total: 3,
                    },
                });
            });

            it('should use default pagination values', async () => {
                mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                    mockRepositories,
                );
                mockAuthorizationService.getRepositoryScope.mockResolvedValue(
                    null,
                );

                const result = await useCase.execute({
                    teamId: 'team-uuid-123',
                    page: 1,
                });

                expect(result).toEqual({
                    data: mockRepositories,
                    pagination: {
                        page: 1,
                        perPage: 20,
                        total: 3,
                    },
                });
            });

            it('should return empty data array when page exceeds total', async () => {
                mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                    mockRepositories,
                );
                mockAuthorizationService.getRepositoryScope.mockResolvedValue(
                    null,
                );

                const result = await useCase.execute({
                    teamId: 'team-uuid-123',
                    page: 10,
                    perPage: 2,
                });

                expect(result).toEqual({
                    data: [],
                    pagination: {
                        page: 10,
                        perPage: 2,
                        total: 3,
                    },
                });
            });
        });
    });
});
