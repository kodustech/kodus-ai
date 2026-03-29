/**
 * Tests for DeleteIntegrationAndRepositoriesUseCase — "Reset integration and remove repositories config"
 *
 * This use case performs full cleanup:
 * 1. Deletes integration + auth + integration config + webhooks (via DeleteIntegrationUseCase)
 * 2. Clears repositories from code_review_config parameter
 * 3. Deletes pull request messages for each repository
 * 4. Inactivates kody rules for each repository
 *
 * Tested across all 4 platforms (GitHub, GitLab, Bitbucket, Azure Repos)
 * with both OAuth and Token auth modes where applicable.
 */

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { DeleteIntegrationAndRepositoriesUseCase } from '../delete-integration-and-repositories.use-case';
import {
    MOCK_ORG_ID,
    MOCK_TEAM_ID,
    MOCK_REPOSITORIES,
    MOCK_CODE_REVIEW_CONFIG,
    createMockParametersService,
    createMockPullRequestMessagesService,
    createMockKodyRulesService,
    createMockCreateOrUpdateParametersUseCase,
} from './shared-delete-mocks';

describe('DeleteIntegrationAndRepositoriesUseCase', () => {
    let useCase: DeleteIntegrationAndRepositoriesUseCase;
    let mockDeleteIntegrationUseCase: { execute: jest.Mock };
    let mockParametersService: ReturnType<typeof createMockParametersService>;
    let mockCreateOrUpdateParametersUseCase: ReturnType<
        typeof createMockCreateOrUpdateParametersUseCase
    >;
    let mockPullRequestMessagesService: ReturnType<
        typeof createMockPullRequestMessagesService
    >;
    let mockKodyRulesService: ReturnType<typeof createMockKodyRulesService>;

    const executeParams = {
        organizationId: MOCK_ORG_ID,
        teamId: MOCK_TEAM_ID,
    };

    beforeEach(() => {
        mockDeleteIntegrationUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        mockParametersService = createMockParametersService();
        mockCreateOrUpdateParametersUseCase =
            createMockCreateOrUpdateParametersUseCase();
        mockPullRequestMessagesService = createMockPullRequestMessagesService();
        mockKodyRulesService = createMockKodyRulesService();

        useCase = new (DeleteIntegrationAndRepositoriesUseCase as any)(
            mockDeleteIntegrationUseCase,
            mockParametersService,
            mockCreateOrUpdateParametersUseCase,
            mockPullRequestMessagesService,
            mockKodyRulesService,
        );
    });

    // ─── Helpers ───────────────────────────────────────────
    function setupWithRepositories() {
        mockParametersService.findOne.mockResolvedValue(
            MOCK_CODE_REVIEW_CONFIG,
        );
    }

    function setupWithNoRepositories() {
        mockParametersService.findOne.mockResolvedValue({
            uuid: 'param-uuid-0001',
            configValue: { repositories: [], configs: {} },
        });
    }

    function setupWithNoCodeReviewConfig() {
        mockParametersService.findOne.mockResolvedValue(null);
    }

    function setupDeleteIntegrationFailure(errorMessage: string) {
        mockDeleteIntegrationUseCase.execute.mockRejectedValue(
            new Error(errorMessage),
        );
    }

    // ─── Shared assertions for full reset ──────────────────
    function assertDeleteIntegrationUseCaseCalled() {
        expect(mockDeleteIntegrationUseCase.execute).toHaveBeenCalledWith(
            executeParams,
        );
    }

    function assertRepositoriesClearedFromConfig() {
        expect(
            mockCreateOrUpdateParametersUseCase.execute,
        ).toHaveBeenCalledWith(
            expect.anything(), // ParametersKey.CODE_REVIEW_CONFIG
            expect.objectContaining({ repositories: [] }),
            { organizationId: MOCK_ORG_ID, teamId: MOCK_TEAM_ID },
        );
    }

    function assertPullRequestMessagesDeletedForAllRepos() {
        for (const repo of MOCK_REPOSITORIES) {
            expect(
                mockPullRequestMessagesService.deleteByFilter,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationId: MOCK_ORG_ID,
                    repositoryId: repo.id,
                }),
            );
        }
    }

    function assertKodyRulesInactivatedForAllRepos() {
        for (const repo of MOCK_REPOSITORIES) {
            expect(
                mockKodyRulesService.updateRulesStatusByFilter,
            ).toHaveBeenCalledWith(
                MOCK_ORG_ID,
                repo.id,
                undefined,
                expect.anything(), // KodyRulesStatus.DELETED
            );
        }
    }

    function assertFullCleanupCompleted() {
        assertDeleteIntegrationUseCaseCalled();
        assertRepositoriesClearedFromConfig();
        assertPullRequestMessagesDeletedForAllRepos();
        assertKodyRulesInactivatedForAllRepos();
    }

    // ═══════════════════════════════════════════════════════
    // GitHub — Full reset (integration + repositories)
    // ═══════════════════════════════════════════════════════
    describe('GitHub', () => {
        describe('OAuth - installation exists on GitHub', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup: integration, configs, PR messages, and kody rules', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('OAuth - installation revoked on GitHub', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure(
                    'Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app',
                );
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });

        describe('Token - valid token', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure('Bad credentials');
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // GitLab — Full reset
    // ═══════════════════════════════════════════════════════
    describe('GitLab', () => {
        describe('OAuth - token exists', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('OAuth - token revoked', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure('401 Unauthorized');
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });

        describe('Token - valid token', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure('401 Unauthorized');
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Bitbucket — Full reset (Token only)
    // ═══════════════════════════════════════════════════════
    describe('Bitbucket', () => {
        describe('Token - valid token', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure('401 Unauthorized');
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Azure Repos — Full reset (Token only)
    // ═══════════════════════════════════════════════════════
    describe('Azure Repos', () => {
        describe('Token - valid token', () => {
            beforeEach(() => setupWithRepositories());

            it('should perform full cleanup', async () => {
                await useCase.execute(executeParams);
                assertFullCleanupCompleted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupWithRepositories();
                setupDeleteIntegrationFailure('401 Unauthorized');
            });

            it('should NOT throw and should still perform full cleanup of our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertRepositoriesClearedFromConfig();
                assertPullRequestMessagesDeletedForAllRepos();
                assertKodyRulesInactivatedForAllRepos();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should handle no repositories configured gracefully', async () => {
            setupWithNoRepositories();

            await useCase.execute(executeParams);

            assertDeleteIntegrationUseCaseCalled();
            // PR messages and kody rules should not be called since no repos
            expect(
                mockPullRequestMessagesService.deleteByFilter,
            ).not.toHaveBeenCalled();
            expect(
                mockKodyRulesService.updateRulesStatusByFilter,
            ).not.toHaveBeenCalled();
        });

        it('should handle missing code_review_config parameter gracefully', async () => {
            setupWithNoCodeReviewConfig();

            await useCase.execute(executeParams);

            assertDeleteIntegrationUseCaseCalled();
            expect(
                mockPullRequestMessagesService.deleteByFilter,
            ).not.toHaveBeenCalled();
            expect(
                mockKodyRulesService.updateRulesStatusByFilter,
            ).not.toHaveBeenCalled();
        });

        it('should continue cleanup even if deleting PR messages for one repo fails', async () => {
            setupWithRepositories();
            mockPullRequestMessagesService.deleteByFilter
                .mockResolvedValueOnce(true) // repo-1 succeeds
                .mockRejectedValueOnce(new Error('DB error')) // repo-2 fails
                .mockResolvedValueOnce(true); // repo-3 succeeds

            // Should NOT throw — individual repo errors are caught
            await useCase.execute(executeParams);

            assertDeleteIntegrationUseCaseCalled();
            // All 3 repos should have been attempted
            expect(
                mockPullRequestMessagesService.deleteByFilter,
            ).toHaveBeenCalledTimes(3);
        });

        it('should continue cleanup even if inactivating kody rules for one repo fails', async () => {
            setupWithRepositories();
            mockKodyRulesService.updateRulesStatusByFilter
                .mockResolvedValueOnce({}) // repo-1 succeeds
                .mockRejectedValueOnce(new Error('DB error')) // repo-2 fails
                .mockResolvedValueOnce({}); // repo-3 succeeds

            // Should NOT throw — individual repo errors are caught
            await useCase.execute(executeParams);

            assertDeleteIntegrationUseCaseCalled();
            // All 3 repos should have been attempted
            expect(
                mockKodyRulesService.updateRulesStatusByFilter,
            ).toHaveBeenCalledTimes(3);
        });
    });
});
