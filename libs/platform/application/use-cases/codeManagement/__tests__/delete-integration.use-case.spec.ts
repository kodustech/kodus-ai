/**
 * Tests for DeleteIntegrationUseCase — "Just reset the integration"
 *
 * This use case deletes the integration, auth integration, integration config
 * (repositories), and webhooks — but does NOT touch code_review_config,
 * pull request messages, or kody rules.
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

import { DeleteIntegrationUseCase } from '../delete-integration.use-case';
import {
    MOCK_AUTH_INTEGRATION_UUID,
    MOCK_INSTALLATION_CONFIG_UUID,
    MOCK_INTEGRATION_CONFIG_UUID,
    MOCK_INTEGRATION_UUID,
    MOCK_ORG_ID,
    MOCK_TEAM_ID,
    createMockAuthIntegrationService,
    createMockCodeManagementService,
    createMockEventEmitter,
    createMockInstallationConfigEntity,
    createMockIntegrationConfigEntity,
    createMockIntegrationConfigService,
    createMockIntegrationEntity,
    createMockIntegrationService,
    createMockCreateOrUpdateParametersUseCase,
    createMockRequest,
} from './shared-delete-mocks';

describe('DeleteIntegrationUseCase', () => {
    let useCase: DeleteIntegrationUseCase;
    let mockIntegrationService: ReturnType<typeof createMockIntegrationService>;
    let mockAuthIntegrationService: ReturnType<
        typeof createMockAuthIntegrationService
    >;
    let mockIntegrationConfigService: ReturnType<
        typeof createMockIntegrationConfigService
    >;
    let mockCodeManagementService: ReturnType<
        typeof createMockCodeManagementService
    >;
    let mockMcpManagerService: {
        deleteConnectionByIntegrationId: jest.Mock;
    };
    let mockCreateOrUpdateParametersUseCase: ReturnType<
        typeof createMockCreateOrUpdateParametersUseCase
    >;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
    let mockRequest: ReturnType<typeof createMockRequest>;

    const executeParams = {
        organizationId: MOCK_ORG_ID,
        teamId: MOCK_TEAM_ID,
    };

    beforeEach(() => {
        mockIntegrationService = createMockIntegrationService();
        mockAuthIntegrationService = createMockAuthIntegrationService();
        mockIntegrationConfigService = createMockIntegrationConfigService();
        mockCodeManagementService = createMockCodeManagementService();
        mockMcpManagerService = {
            deleteConnectionByIntegrationId: jest.fn().mockResolvedValue(true),
        };
        mockCreateOrUpdateParametersUseCase =
            createMockCreateOrUpdateParametersUseCase();
        mockEventEmitter = createMockEventEmitter();
        mockRequest = createMockRequest();

        useCase = new (DeleteIntegrationUseCase as any)(
            mockCodeManagementService,
            mockIntegrationService,
            mockAuthIntegrationService,
            mockIntegrationConfigService,
            mockCreateOrUpdateParametersUseCase,
            mockEventEmitter,
            mockMcpManagerService,
            mockRequest,
        );
    });

    // ─── Helper ────────────────────────────────────────────
    function setupIntegration(platform: string, authMode: string) {
        const integration = createMockIntegrationEntity(platform, authMode);
        mockIntegrationService.findOne.mockResolvedValue(integration);
        mockIntegrationConfigService.find.mockResolvedValue([
            createMockIntegrationConfigEntity(),
        ]);
        return integration;
    }

    function setupNoIntegration() {
        mockIntegrationService.findOne.mockResolvedValue(null);
    }

    // ─── Shared assertions ─────────────────────────────────
    function assertIntegrationDeleted() {
        expect(mockIntegrationService.delete).toHaveBeenCalledWith(
            MOCK_INTEGRATION_UUID,
        );
    }

    function assertAuthIntegrationDeleted() {
        expect(mockAuthIntegrationService.delete).toHaveBeenCalledWith(
            MOCK_AUTH_INTEGRATION_UUID,
        );
    }

    function assertIntegrationConfigDeleted() {
        expect(mockIntegrationConfigService.delete).toHaveBeenCalledWith(
            MOCK_INTEGRATION_CONFIG_UUID,
        );
    }

    function assertCentralizedConfigDisabled() {
        expect(
            mockCreateOrUpdateParametersUseCase.execute,
        ).toHaveBeenCalledWith(
            expect.anything(), // ParametersKey.CENTRALIZED_CONFIG
            { enabled: false, repository: null, activePullRequest: null },
            { organizationId: MOCK_ORG_ID, teamId: MOCK_TEAM_ID },
        );
    }

    function assertWebhookDeletionAttempted() {
        expect(mockCodeManagementService.deleteWebhook).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: MOCK_ORG_ID,
                teamId: MOCK_TEAM_ID,
            },
        });
    }

    function assertAuditLogEmitted() {
        expect(mockEventEmitter.emit).toHaveBeenCalled();
    }

    // ═══════════════════════════════════════════════════════
    // GitHub
    // ═══════════════════════════════════════════════════════
    describe('GitHub', () => {
        describe('OAuth - installation exists on GitHub', () => {
            beforeEach(() => setupIntegration('github', 'oauth'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertCentralizedConfigDisabled();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('OAuth - installation revoked on GitHub', () => {
            beforeEach(() => {
                setupIntegration('github', 'oauth');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error(
                        'Not Found - https://docs.github.com/rest/reference/apps#create-an-installation-access-token-for-an-app',
                    ),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertCentralizedConfigDisabled();
            });
        });

        describe('Token - valid token', () => {
            beforeEach(() => setupIntegration('github', 'token'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertCentralizedConfigDisabled();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupIntegration('github', 'token');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error('Bad credentials'),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertCentralizedConfigDisabled();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // GitLab
    // ═══════════════════════════════════════════════════════
    describe('GitLab', () => {
        describe('OAuth - token exists', () => {
            beforeEach(() => setupIntegration('gitlab', 'oauth'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertCentralizedConfigDisabled();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('OAuth - token revoked', () => {
            beforeEach(() => {
                setupIntegration('gitlab', 'oauth');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error('401 Unauthorized'),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertCentralizedConfigDisabled();
            });
        });

        describe('Token - valid token', () => {
            beforeEach(() => setupIntegration('gitlab', 'token'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertCentralizedConfigDisabled();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupIntegration('gitlab', 'token');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error('401 Unauthorized'),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertCentralizedConfigDisabled();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Bitbucket (Token only)
    // ═══════════════════════════════════════════════════════
    describe('Bitbucket', () => {
        describe('Token - valid token', () => {
            beforeEach(() => setupIntegration('bitbucket', 'token'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupIntegration('bitbucket', 'token');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error('401 Unauthorized'),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Azure Repos (Token only)
    // ═══════════════════════════════════════════════════════
    describe('Azure Repos', () => {
        describe('Token - valid token', () => {
            beforeEach(() => setupIntegration('azure_repos', 'token'));

            it('should delete webhook, integration config, integration, and auth integration', async () => {
                await useCase.execute(executeParams);

                assertWebhookDeletionAttempted();
                assertIntegrationConfigDeleted();
                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
                assertAuditLogEmitted();
            });
        });

        describe('Token - revoked token', () => {
            beforeEach(() => {
                setupIntegration('azure_repos', 'token');
                mockCodeManagementService.deleteWebhook.mockRejectedValue(
                    new Error('401 Unauthorized'),
                );
            });

            it('should NOT throw and should still delete integration and auth from our database', async () => {
                await expect(
                    useCase.execute(executeParams),
                ).resolves.toBeUndefined();

                assertIntegrationDeleted();
                assertAuthIntegrationDeleted();
            });
        });
    });

    // ═══════════════════════════════════════════════════════
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should do nothing when integration is not found in database', async () => {
            setupNoIntegration();

            await useCase.execute(executeParams);

            expect(
                mockCodeManagementService.deleteWebhook,
            ).not.toHaveBeenCalled();
            expect(mockIntegrationService.delete).not.toHaveBeenCalled();
            expect(mockAuthIntegrationService.delete).not.toHaveBeenCalled();
            expect(mockIntegrationConfigService.delete).not.toHaveBeenCalled();
        });

        it('should proceed when no integration config exists', async () => {
            setupIntegration('github', 'oauth');
            mockIntegrationConfigService.find.mockResolvedValue([]);

            await useCase.execute(executeParams);

            assertWebhookDeletionAttempted();
            assertIntegrationDeleted();
            assertAuthIntegrationDeleted();
            assertCentralizedConfigDisabled();
            expect(mockIntegrationConfigService.delete).not.toHaveBeenCalled();
        });

        it('should delete ALL configs tied to the integration, not only repositories', async () => {
            setupIntegration('github', 'oauth');
            mockIntegrationConfigService.find.mockResolvedValue([
                createMockIntegrationConfigEntity(),
                createMockInstallationConfigEntity(),
            ]);

            await useCase.execute(executeParams);

            expect(mockIntegrationConfigService.find).toHaveBeenCalledWith({
                integration: { uuid: MOCK_INTEGRATION_UUID },
            });
            expect(mockIntegrationConfigService.delete).toHaveBeenCalledWith(
                MOCK_INTEGRATION_CONFIG_UUID,
            );
            expect(mockIntegrationConfigService.delete).toHaveBeenCalledWith(
                MOCK_INSTALLATION_CONFIG_UUID,
            );
            assertIntegrationDeleted();
            assertAuthIntegrationDeleted();
        });
    });
});
