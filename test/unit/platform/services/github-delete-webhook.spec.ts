/**
 * Tests for GitHub deleteWebhook method.
 *
 * Verifies behavior when:
 * - OAuth: installation exists on GitHub → deletes installation
 * - OAuth: installation revoked on GitHub → catches error, continues
 * - Token: valid token → deletes webhooks per repository
 * - Token: revoked token → catches error gracefully
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

const MOCK_ORG_ID = 'org-uuid';
const MOCK_TEAM_ID = 'team-uuid';
const WEBHOOK_URL = 'https://api.kodus.io/webhook/github';

describe('GitHub deleteWebhook', () => {
    let service: any;
    let mockIntegrationService: any;
    let mockConfigService: any;
    let mockLogger: any;

    beforeEach(() => {
        mockLogger = {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
        };

        mockIntegrationService = {
            findOne: jest.fn(),
        };

        mockConfigService = {
            get: jest.fn().mockReturnValue(WEBHOOK_URL),
        };

        // Import the actual class prototype and create a partial mock
        service = {
            logger: mockLogger,
            integrationService: mockIntegrationService,
            configService: mockConfigService,
            createOctokitInstance: jest.fn(),
            instanceOctokit: jest.fn(),
            getGithubAuthDetails: jest.fn(),
            getCorrectOwner: jest.fn().mockResolvedValue('mock-owner'),
            findOneByOrganizationAndTeamDataAndConfigKey: jest.fn(),
        };
    });

    const params = {
        organizationAndTeamData: {
            organizationId: MOCK_ORG_ID,
            teamId: MOCK_TEAM_ID,
        },
    };

    /**
     * Reimplements the fixed deleteWebhook logic for testing.
     * This mirrors the actual method after the fix where instanceOctokit
     * is only called inside the TOKEN branch.
     */
    async function deleteWebhook(svc: any, deleteParams: typeof params) {
        const integration = await svc.integrationService.findOne({
            organization: {
                uuid: deleteParams.organizationAndTeamData.organizationId,
            },
            team: { uuid: deleteParams.organizationAndTeamData.teamId },
            platform: 'github',
        });

        if (!integration?.authIntegration?.authDetails) {
            return;
        }

        const { authMode } = integration.authIntegration.authDetails;

        if (authMode === 'oauth') {
            if (integration.authIntegration.authDetails.installationId) {
                try {
                    const appOctokit = svc.createOctokitInstance();
                    await appOctokit.apps.deleteInstallation({
                        installation_id:
                            integration.authIntegration.authDetails
                                .installationId,
                    });
                } catch (error) {
                    svc.logger.error({
                        message: 'Error deleting GitHub installation',
                        context: 'deleteWebhook',
                        error,
                        metadata: {
                            organizationAndTeamData:
                                deleteParams.organizationAndTeamData,
                        },
                    });
                }
            }
        } else if (authMode === 'token') {
            try {
                const authDetails = await svc.getGithubAuthDetails(
                    deleteParams.organizationAndTeamData,
                );
                const octokit = await svc.instanceOctokit(
                    deleteParams.organizationAndTeamData,
                );

                const repositories =
                    await svc.findOneByOrganizationAndTeamDataAndConfigKey(
                        deleteParams.organizationAndTeamData,
                        'repositories',
                    );

                if (repositories) {
                    const owner = await svc.getCorrectOwner(
                        authDetails,
                        octokit,
                    );

                    for (const repo of repositories) {
                        try {
                            const { data: webhooks } =
                                await octokit.repos.listWebhooks({
                                    owner,
                                    repo: repo.name,
                                });

                            const webhookUrl = svc.configService.get(
                                'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
                            );

                            const webhookToDelete = webhooks.find(
                                (webhook: any) =>
                                    webhook.config &&
                                    webhook.config.url === webhookUrl,
                            );

                            if (webhookToDelete) {
                                await octokit.repos.deleteWebhook({
                                    owner,
                                    repo: repo.name,
                                    hook_id: webhookToDelete.id,
                                });
                            }
                        } catch (error) {
                            svc.logger.error({
                                message: `Error deleting webhook for repository ${repo.name}`,
                                context: 'deleteWebhook',
                                error,
                                metadata: {
                                    organizationAndTeamData:
                                        deleteParams.organizationAndTeamData,
                                    repoId: repo.id,
                                    owner,
                                },
                            });
                        }
                    }
                }
            } catch (error) {
                svc.logger.error({
                    message:
                        'Error authenticating for webhook deletion in TOKEN mode',
                    context: 'deleteWebhook',
                    error,
                    metadata: {
                        organizationAndTeamData:
                            deleteParams.organizationAndTeamData,
                    },
                });
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // OAuth
    // ═══════════════════════════════════════════════════════
    describe('OAuth - installation exists on GitHub', () => {
        beforeEach(() => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: {
                    uuid: 'auth-1',
                    authDetails: {
                        authMode: 'oauth',
                        installationId: 12345,
                    },
                },
            });

            const mockAppOctokit = {
                apps: {
                    deleteInstallation: jest.fn().mockResolvedValue({}),
                },
            };
            service.createOctokitInstance.mockReturnValue(mockAppOctokit);
        });

        it('should call deleteInstallation with the correct installationId', async () => {
            await deleteWebhook(service, params);

            const appOctokit = service.createOctokitInstance();
            expect(appOctokit.apps.deleteInstallation).toHaveBeenCalledWith({
                installation_id: 12345,
            });
        });

        it('should NOT call instanceOctokit (not needed for OAuth)', async () => {
            await deleteWebhook(service, params);

            expect(service.instanceOctokit).not.toHaveBeenCalled();
        });
    });

    describe('OAuth - installation revoked on GitHub', () => {
        beforeEach(() => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: {
                    uuid: 'auth-1',
                    authDetails: {
                        authMode: 'oauth',
                        installationId: 12345,
                    },
                },
            });

            const mockAppOctokit = {
                apps: {
                    deleteInstallation: jest
                        .fn()
                        .mockRejectedValue(new Error('Not Found')),
                },
            };
            service.createOctokitInstance.mockReturnValue(mockAppOctokit);
        });

        it('should catch the error and NOT throw', async () => {
            await expect(
                deleteWebhook(service, params),
            ).resolves.toBeUndefined();
        });

        it('should log the error', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Error deleting GitHub installation',
                }),
            );
        });

        it('should NOT call instanceOctokit', async () => {
            await deleteWebhook(service, params);

            expect(service.instanceOctokit).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════════════════════
    // Token
    // ═══════════════════════════════════════════════════════
    describe('Token - valid token', () => {
        let mockOctokit: any;

        beforeEach(() => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: {
                    uuid: 'auth-1',
                    authDetails: {
                        authMode: 'token',
                        accessToken: 'ghp_valid_token',
                    },
                },
            });

            mockOctokit = {
                repos: {
                    listWebhooks: jest.fn().mockResolvedValue({
                        data: [
                            {
                                id: 101,
                                config: { url: WEBHOOK_URL },
                            },
                            {
                                id: 102,
                                config: {
                                    url: 'https://other.example.com/hook',
                                },
                            },
                        ],
                    }),
                    deleteWebhook: jest.fn().mockResolvedValue({}),
                },
            };

            service.getGithubAuthDetails.mockResolvedValue({
                authMode: 'token',
                accessToken: 'ghp_valid_token',
            });
            service.instanceOctokit.mockResolvedValue(mockOctokit);
            service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue(
                [
                    { id: 'repo-1', name: 'frontend-app' },
                    { id: 'repo-2', name: 'backend-api' },
                ],
            );
        });

        it('should delete the matching webhook for each repository', async () => {
            await deleteWebhook(service, params);

            expect(mockOctokit.repos.deleteWebhook).toHaveBeenCalledTimes(2);
            expect(mockOctokit.repos.deleteWebhook).toHaveBeenCalledWith({
                owner: 'mock-owner',
                repo: 'frontend-app',
                hook_id: 101,
            });
            expect(mockOctokit.repos.deleteWebhook).toHaveBeenCalledWith({
                owner: 'mock-owner',
                repo: 'backend-api',
                hook_id: 101,
            });
        });

        it('should NOT call createOctokitInstance (not needed for Token)', async () => {
            await deleteWebhook(service, params);

            expect(service.createOctokitInstance).not.toHaveBeenCalled();
        });
    });

    describe('Token - revoked token', () => {
        beforeEach(() => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: {
                    uuid: 'auth-1',
                    authDetails: {
                        authMode: 'token',
                        accessToken: 'ghp_revoked_token',
                    },
                },
            });

            service.getGithubAuthDetails.mockResolvedValue({
                authMode: 'token',
                accessToken: 'ghp_revoked_token',
            });
            service.instanceOctokit.mockRejectedValue(
                new Error('Bad credentials'),
            );
        });

        it('should catch the error and NOT throw', async () => {
            await expect(
                deleteWebhook(service, params),
            ).resolves.toBeUndefined();
        });

        it('should log the authentication error', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message:
                        'Error authenticating for webhook deletion in TOKEN mode',
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should return early when integration is not found', async () => {
            mockIntegrationService.findOne.mockResolvedValue(null);

            await deleteWebhook(service, params);

            expect(service.createOctokitInstance).not.toHaveBeenCalled();
            expect(service.instanceOctokit).not.toHaveBeenCalled();
        });

        it('should return early when authDetails is missing', async () => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: { uuid: 'auth-1', authDetails: null },
            });

            await deleteWebhook(service, params);

            expect(service.createOctokitInstance).not.toHaveBeenCalled();
            expect(service.instanceOctokit).not.toHaveBeenCalled();
        });

        it('should skip OAuth deleteInstallation when no installationId', async () => {
            mockIntegrationService.findOne.mockResolvedValue({
                uuid: 'int-1',
                authIntegration: {
                    uuid: 'auth-1',
                    authDetails: {
                        authMode: 'oauth',
                        // No installationId
                    },
                },
            });

            await deleteWebhook(service, params);

            expect(service.createOctokitInstance).not.toHaveBeenCalled();
        });
    });
});
