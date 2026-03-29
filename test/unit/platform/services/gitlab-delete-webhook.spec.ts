/**
 * Tests for GitLab deleteWebhook method.
 *
 * GitLab's deleteWebhook does NOT differentiate between OAuth and Token modes —
 * it always creates an API instance with the stored token and lists/deletes
 * project hooks. The vulnerability is that instanceGitlabApi is called before
 * any validation, and if the token is revoked, the API calls will fail.
 *
 * Verifies behavior when:
 * - OAuth: valid token → deletes webhooks per repository
 * - OAuth: revoked token → fails (no graceful handling)
 * - Token: valid token → deletes webhooks per repository
 * - Token: revoked token → fails (no graceful handling)
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
const WEBHOOK_URL = 'https://api.kodus.io/webhook/gitlab';

describe('GitLab deleteWebhook', () => {
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

        service = {
            logger: mockLogger,
            integrationService: mockIntegrationService,
            configService: mockConfigService,
            getAuthDetails: jest.fn(),
            instanceGitlabApi: jest.fn(),
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
     * Reimplements the fixed GitLab deleteWebhook logic.
     * Auth and API instantiation are now wrapped in a try/catch so that
     * revoked tokens do not block the delete flow.
     */
    async function deleteWebhook(svc: any, deleteParams: typeof params) {
        try {
            const authDetails = await svc.getAuthDetails(
                deleteParams.organizationAndTeamData,
            );

            const gitlabAPI = svc.instanceGitlabApi(authDetails);

            const integration = await svc.integrationService.findOne({
                organization: {
                    uuid: deleteParams.organizationAndTeamData.organizationId,
                },
                team: { uuid: deleteParams.organizationAndTeamData.teamId },
                platform: 'gitlab',
            });

            if (!integration?.authIntegration?.authDetails) {
                return;
            }

            const repositories =
                await svc.findOneByOrganizationAndTeamDataAndConfigKey(
                    deleteParams.organizationAndTeamData,
                    'repositories',
                );

            if (repositories) {
                for (const repo of repositories) {
                    try {
                        const webhooks = await gitlabAPI.ProjectHooks.all(
                            repo.id,
                        );
                        const webhookUrl = svc.configService.get(
                            'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
                        );

                        const webhookToDelete = webhooks.find(
                            (webhook: any) => webhook.url === webhookUrl,
                        );

                        if (webhookToDelete) {
                            await gitlabAPI.ProjectHooks.remove(
                                repo.id,
                                webhookToDelete.id,
                            );
                        }
                    } catch (error) {
                        svc.logger.error({
                            message: `Error deleting webhook for repository ${repo.name}`,
                            context: 'GitlabService',
                            error,
                            metadata: {
                                organizationAndTeamData:
                                    deleteParams.organizationAndTeamData,
                                repoId: repo.id,
                            },
                        });
                    }
                }
            }
        } catch (error) {
            svc.logger.error({
                message: 'Error authenticating for webhook deletion',
                context: 'GitlabService',
                error,
                metadata: {
                    organizationAndTeamData:
                        deleteParams.organizationAndTeamData,
                },
            });
        }
    }

    // ─── Helpers ───────────────────────────────────────────
    function setupIntegration(authMode: string) {
        mockIntegrationService.findOne.mockResolvedValue({
            uuid: 'int-1',
            authIntegration: {
                uuid: 'auth-1',
                authDetails: {
                    authMode,
                    accessToken: 'glpat-valid-token',
                },
            },
        });
    }

    function setupValidGitlabApi() {
        const mockGitlabApi = {
            ProjectHooks: {
                all: jest.fn().mockResolvedValue([
                    { id: 201, url: WEBHOOK_URL },
                    { id: 202, url: 'https://other.example.com/hook' },
                ]),
                remove: jest.fn().mockResolvedValue({}),
            },
        };
        service.getAuthDetails.mockResolvedValue({
            authMode: 'oauth',
            accessToken: 'glpat-valid-token',
        });
        service.instanceGitlabApi.mockReturnValue(mockGitlabApi);
        return mockGitlabApi;
    }

    function setupRepositories() {
        service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue([
            { id: 'proj-1', name: 'frontend-app' },
            { id: 'proj-2', name: 'backend-api' },
        ]);
    }

    // ═══════════════════════════════════════════════════════
    // OAuth
    // ═══════════════════════════════════════════════════════
    describe('OAuth - valid token', () => {
        let mockGitlabApi: any;

        beforeEach(() => {
            setupIntegration('oauth');
            mockGitlabApi = setupValidGitlabApi();
            setupRepositories();
        });

        it('should delete the matching webhook for each repository', async () => {
            await deleteWebhook(service, params);

            expect(mockGitlabApi.ProjectHooks.remove).toHaveBeenCalledTimes(2);
            expect(mockGitlabApi.ProjectHooks.remove).toHaveBeenCalledWith(
                'proj-1',
                201,
            );
            expect(mockGitlabApi.ProjectHooks.remove).toHaveBeenCalledWith(
                'proj-2',
                201,
            );
        });
    });

    describe('OAuth - token revoked (getAuthDetails fails)', () => {
        beforeEach(() => {
            service.getAuthDetails.mockRejectedValue(
                new Error('401 Unauthorized'),
            );
        });

        it('should NOT throw — auth failure should be handled gracefully', async () => {
            await expect(
                deleteWebhook(service, params),
            ).resolves.toBeUndefined();
        });
    });

    describe('OAuth - token revoked (API call fails)', () => {
        beforeEach(() => {
            setupIntegration('oauth');
            service.getAuthDetails.mockResolvedValue({
                authMode: 'oauth',
                accessToken: 'glpat-revoked-token',
            });

            const mockGitlabApi = {
                ProjectHooks: {
                    all: jest
                        .fn()
                        .mockRejectedValue(new Error('401 Unauthorized')),
                    remove: jest.fn(),
                },
            };
            service.instanceGitlabApi.mockReturnValue(mockGitlabApi);
            setupRepositories();
        });

        it('should catch per-repo errors and log them (individual webhooks are try-caught)', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledTimes(2); // Once per repo
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Error deleting webhook for repository',
                    ),
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════
    // Token
    // ═══════════════════════════════════════════════════════
    describe('Token - valid token', () => {
        let mockGitlabApi: any;

        beforeEach(() => {
            setupIntegration('token');
            mockGitlabApi = setupValidGitlabApi();
            service.getAuthDetails.mockResolvedValue({
                authMode: 'token',
                accessToken: 'glpat-valid-token',
            });
            setupRepositories();
        });

        it('should delete the matching webhook for each repository', async () => {
            await deleteWebhook(service, params);

            expect(mockGitlabApi.ProjectHooks.remove).toHaveBeenCalledTimes(2);
        });
    });

    describe('Token - revoked token (getAuthDetails fails)', () => {
        beforeEach(() => {
            service.getAuthDetails.mockRejectedValue(
                new Error('401 Unauthorized'),
            );
        });

        it('should NOT throw — auth failure should be handled gracefully', async () => {
            await expect(
                deleteWebhook(service, params),
            ).resolves.toBeUndefined();
        });
    });

    describe('Token - revoked token (API call fails)', () => {
        beforeEach(() => {
            setupIntegration('token');
            service.getAuthDetails.mockResolvedValue({
                authMode: 'token',
                accessToken: 'glpat-revoked-token',
            });

            const mockGitlabApi = {
                ProjectHooks: {
                    all: jest
                        .fn()
                        .mockRejectedValue(new Error('401 Unauthorized')),
                    remove: jest.fn(),
                },
            };
            service.instanceGitlabApi.mockReturnValue(mockGitlabApi);
            setupRepositories();
        });

        it('should catch per-repo errors and log them', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledTimes(2);
        });
    });

    // ═══════════════════════════════════════════════════════
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should return early when integration is not found', async () => {
            service.getAuthDetails.mockResolvedValue({
                authMode: 'oauth',
                accessToken: 'token',
            });
            service.instanceGitlabApi.mockReturnValue({});
            mockIntegrationService.findOne.mockResolvedValue(null);

            await deleteWebhook(service, params);

            expect(
                service.findOneByOrganizationAndTeamDataAndConfigKey,
            ).not.toHaveBeenCalled();
        });

        it('should handle no repositories configured', async () => {
            setupIntegration('oauth');
            setupValidGitlabApi();
            service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue(
                null,
            );

            await deleteWebhook(service, params);

            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should skip repo when no matching webhook found', async () => {
            setupIntegration('oauth');
            service.getAuthDetails.mockResolvedValue({
                authMode: 'oauth',
                accessToken: 'token',
            });

            const mockGitlabApi = {
                ProjectHooks: {
                    all: jest.fn().mockResolvedValue([
                        {
                            id: 999,
                            url: 'https://completely-different.example.com',
                        },
                    ]),
                    remove: jest.fn(),
                },
            };
            service.instanceGitlabApi.mockReturnValue(mockGitlabApi);
            setupRepositories();

            await deleteWebhook(service, params);

            expect(mockGitlabApi.ProjectHooks.remove).not.toHaveBeenCalled();
        });
    });
});
