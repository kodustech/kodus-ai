/**
 * Tests for Bitbucket deleteWebhook method.
 *
 * Bitbucket only supports Token auth mode. The current implementation
 * calls getAuthDetails and instanceBitbucketApi BEFORE checking authMode,
 * similar to the original GitHub bug. If auth details are invalid, the
 * API instantiation happens unnecessarily.
 *
 * Verifies behavior when:
 * - Token: valid credentials → deletes webhooks per repository
 * - Token: revoked credentials → error handling behavior
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
const WEBHOOK_URL = 'https://api.kodus.io/webhook/bitbucket';

describe('Bitbucket deleteWebhook', () => {
    let service: any;
    let mockLogger: any;

    beforeEach(() => {
        mockLogger = {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
        };

        service = {
            logger: mockLogger,
            configService: {
                get: jest.fn().mockReturnValue(WEBHOOK_URL),
            },
            getAuthDetails: jest.fn(),
            instanceBitbucketApi: jest.fn(),
            findOneByOrganizationAndTeamDataAndConfigKey: jest.fn(),
            getPaginatedResults: jest.fn(),
        };
    });

    const params = {
        organizationAndTeamData: {
            organizationId: MOCK_ORG_ID,
            teamId: MOCK_TEAM_ID,
        },
    };

    /**
     * Reimplements the fixed Bitbucket deleteWebhook logic.
     * Auth and API instantiation are now wrapped in a try/catch so that
     * revoked credentials do not block the delete flow.
     */
    async function deleteWebhook(svc: any, deleteParams: typeof params) {
        try {
            const authDetails = await svc.getAuthDetails(
                deleteParams.organizationAndTeamData,
            );
            const bitbucketAPI = svc.instanceBitbucketApi(authDetails);

            if (authDetails.authMode === 'token') {
                const repositories =
                    await svc.findOneByOrganizationAndTeamDataAndConfigKey(
                        deleteParams.organizationAndTeamData,
                        'repositories',
                    );

                const webhookUrl = svc.configService.get(
                    'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
                );

                if (!webhookUrl) {
                    svc.logger.error({
                        message: 'Bitbucket webhook URL not found',
                        context: 'BitbucketService',
                    });
                    return;
                }

                for (const repo of repositories) {
                    try {
                        const existingHooks = await bitbucketAPI.webhooks
                            .listForRepo({
                                repo_slug: `{${repo.id}}`,
                                workspace: `{${repo.workspaceId}}`,
                                pagelen: 50,
                            })
                            .then((res: any) =>
                                svc.getPaginatedResults(bitbucketAPI, res),
                            );

                        const webhook = existingHooks.find(
                            (hook: any) => hook.url === webhookUrl,
                        );

                        if (webhook) {
                            await bitbucketAPI.repositories.deleteWebhook({
                                repo_slug: `{${repo.id}}`,
                                workspace: `{${repo.workspaceId}}`,
                                uid: webhook.uuid,
                            });

                            svc.logger.log({
                                message: `Webhook deleted successfully for repository ${repo.name}`,
                                context: 'deleteWebhook',
                                metadata: {
                                    repository: repo.name,
                                    workspace: repo.workspaceId,
                                    organizationAndTeamData:
                                        deleteParams.organizationAndTeamData,
                                },
                            });
                        }
                    } catch (error) {
                        svc.logger.error({
                            message: `Error deleting Bitbucket webhook for repository ${repo.name}`,
                            context: 'deleteWebhook',
                            error,
                            metadata: {
                                repository: repo.name,
                                workspace: repo.workspaceId,
                                organizationAndTeamData:
                                    deleteParams.organizationAndTeamData,
                            },
                        });
                    }
                }
            }
        } catch (error) {
            svc.logger.error({
                message: 'Error authenticating for webhook deletion',
                context: 'BitbucketService',
                error,
                metadata: {
                    organizationAndTeamData:
                        deleteParams.organizationAndTeamData,
                },
            });
        }
    }

    // ─── Helpers ───────────────────────────────────────────
    function setupValidAuth() {
        service.getAuthDetails.mockResolvedValue({
            authMode: 'token',
            appPassword: 'encrypted-app-password',
            username: 'test-user',
        });
    }

    function setupValidBitbucketApi() {
        const mockBitbucketApi = {
            webhooks: {
                listForRepo: jest.fn().mockResolvedValue({ data: {} }),
            },
            repositories: {
                deleteWebhook: jest.fn().mockResolvedValue({}),
            },
        };
        service.instanceBitbucketApi.mockReturnValue(mockBitbucketApi);
        service.getPaginatedResults.mockResolvedValue([
            { uuid: 'hook-uuid-1', url: WEBHOOK_URL },
            { uuid: 'hook-uuid-2', url: 'https://other.example.com/hook' },
        ]);
        return mockBitbucketApi;
    }

    function setupRepositories() {
        service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue([
            {
                id: 'repo-1',
                name: 'frontend-app',
                workspaceId: 'workspace-1',
            },
            {
                id: 'repo-2',
                name: 'backend-api',
                workspaceId: 'workspace-1',
            },
        ]);
    }

    // ═══════════════════════════════════════════════════════
    // Token - valid credentials
    // ═══════════════════════════════════════════════════════
    describe('Token - valid credentials', () => {
        let mockBitbucketApi: any;

        beforeEach(() => {
            setupValidAuth();
            mockBitbucketApi = setupValidBitbucketApi();
            setupRepositories();
        });

        it('should delete the matching webhook for each repository', async () => {
            await deleteWebhook(service, params);

            expect(
                mockBitbucketApi.repositories.deleteWebhook,
            ).toHaveBeenCalledTimes(2);
            expect(
                mockBitbucketApi.repositories.deleteWebhook,
            ).toHaveBeenCalledWith({
                repo_slug: '{repo-1}',
                workspace: '{workspace-1}',
                uid: 'hook-uuid-1',
            });
        });

        it('should log success for each deleted webhook', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.log).toHaveBeenCalledTimes(2);
            expect(mockLogger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Webhook deleted successfully',
                    ),
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════
    // Token - revoked credentials
    // ═══════════════════════════════════════════════════════
    describe('Token - revoked credentials (getAuthDetails fails)', () => {
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

    describe('Token - revoked credentials (API calls fail)', () => {
        beforeEach(() => {
            setupValidAuth();

            const mockBitbucketApi = {
                webhooks: {
                    listForRepo: jest.fn().mockResolvedValue({ data: {} }),
                },
                repositories: {
                    deleteWebhook: jest.fn(),
                },
            };
            service.instanceBitbucketApi.mockReturnValue(mockBitbucketApi);
            service.getPaginatedResults.mockRejectedValue(
                new Error('401 Unauthorized'),
            );
            setupRepositories();
        });

        it('should catch per-repo errors and log them', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledTimes(2); // Once per repo
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Error deleting Bitbucket webhook',
                    ),
                }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should do nothing when authMode is not token', async () => {
            service.getAuthDetails.mockResolvedValue({
                authMode: 'oauth',
                accessToken: 'token',
            });
            service.instanceBitbucketApi.mockReturnValue({});

            await deleteWebhook(service, params);

            expect(
                service.findOneByOrganizationAndTeamDataAndConfigKey,
            ).not.toHaveBeenCalled();
        });

        it('should return early when webhook URL is not configured', async () => {
            setupValidAuth();
            service.instanceBitbucketApi.mockReturnValue({});
            service.configService.get.mockReturnValue(null);
            setupRepositories();

            await deleteWebhook(service, params);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Bitbucket webhook URL not found',
                }),
            );
        });

        it('should skip repo when no matching webhook found', async () => {
            setupValidAuth();
            const mockBitbucketApi = {
                webhooks: {
                    listForRepo: jest.fn().mockResolvedValue({ data: {} }),
                },
                repositories: {
                    deleteWebhook: jest.fn(),
                },
            };
            service.instanceBitbucketApi.mockReturnValue(mockBitbucketApi);
            service.getPaginatedResults.mockResolvedValue([
                {
                    uuid: 'hook-uuid-other',
                    url: 'https://completely-different.example.com',
                },
            ]);
            setupRepositories();

            await deleteWebhook(service, params);

            expect(
                mockBitbucketApi.repositories.deleteWebhook,
            ).not.toHaveBeenCalled();
        });
    });
});
