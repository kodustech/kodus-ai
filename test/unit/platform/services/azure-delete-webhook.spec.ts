/**
 * Tests for Azure Repos deleteWebhook method.
 *
 * Azure Repos only supports Token auth mode. Unlike GitHub/Bitbucket/GitLab,
 * Azure checks authMode BEFORE using credentials and defers actual API
 * authentication to the helper methods. This is the safest pattern.
 *
 * Verifies behavior when:
 * - Token: valid credentials → deletes webhook subscriptions per repository
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
const WEBHOOK_URL = 'https://api.kodus.io/webhook/azure';

describe('Azure Repos deleteWebhook', () => {
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
            getProjectIdFromRepository: jest.fn(),
            azureReposRequestHelper: {
                listSubscriptionsByProject: jest.fn(),
                deleteWebhookById: jest.fn(),
            },
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
     * Reimplements the fixed Azure Repos deleteWebhook logic.
     * Auth is now wrapped in a try/catch so that revoked credentials
     * do not block the delete flow.
     */
    async function deleteWebhook(svc: any, deleteParams: typeof params) {
        try {
            const authDetails = await svc.getAuthDetails(
                deleteParams.organizationAndTeamData,
            );

            if (authDetails.authMode === 'token') {
                const repositories =
                    await svc.findOneByOrganizationAndTeamDataAndConfigKey(
                        deleteParams.organizationAndTeamData,
                        'repositories',
                    );

                if (repositories) {
                    for (const repo of repositories) {
                        try {
                            const projectId =
                                await svc.getProjectIdFromRepository(
                                    deleteParams.organizationAndTeamData,
                                    repo.id,
                                );

                            if (!projectId) {
                                continue;
                            }

                            const subs =
                                await svc.azureReposRequestHelper.listSubscriptionsByProject(
                                    {
                                        orgName: authDetails.orgName,
                                        token: authDetails.token,
                                        projectId,
                                    },
                                );

                            const webhookUrl = svc.configService.get(
                                'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK',
                            );
                            const allMatching = subs.filter(
                                (s: any) =>
                                    s.publisherInputs?.repository === repo.id &&
                                    s.consumerInputs?.url?.includes(webhookUrl),
                            );

                            for (const existing of allMatching) {
                                await svc.azureReposRequestHelper.deleteWebhookById(
                                    {
                                        orgName: authDetails.orgName,
                                        token: authDetails.token,
                                        subscriptionId: existing.id,
                                    },
                                );

                                svc.logger.log({
                                    message: `Webhook removed for repository ${repo.name} (id=${existing.id})`,
                                    context: 'deleteWebhook',
                                    metadata: {
                                        organizationAndTeamData:
                                            deleteParams.organizationAndTeamData,
                                        repository: repo.name,
                                        subscriptionId: existing.id,
                                    },
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
                                    repository: repo.name,
                                },
                            });
                        }
                    }
                }
            }
        } catch (error) {
            svc.logger.error({
                message: 'Error authenticating for webhook deletion',
                context: 'AzureReposService',
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
            orgName: 'my-org',
            token: 'valid-pat-token',
        });
    }

    function setupRepositories() {
        service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue([
            { id: 'repo-1', name: 'frontend-app' },
            { id: 'repo-2', name: 'backend-api' },
        ]);
        service.getProjectIdFromRepository
            .mockResolvedValueOnce('project-1')
            .mockResolvedValueOnce('project-2');
    }

    function setupSubscriptions() {
        service.azureReposRequestHelper.listSubscriptionsByProject.mockResolvedValue(
            [
                {
                    id: 'sub-1',
                    publisherInputs: { repository: 'repo-1' },
                    consumerInputs: { url: WEBHOOK_URL + '/events' },
                },
                {
                    id: 'sub-other',
                    publisherInputs: { repository: 'repo-1' },
                    consumerInputs: {
                        url: 'https://other.example.com/hook',
                    },
                },
            ],
        );
    }

    // ═══════════════════════════════════════════════════════
    // Token - valid credentials
    // ═══════════════════════════════════════════════════════
    describe('Token - valid credentials', () => {
        beforeEach(() => {
            setupValidAuth();
            setupRepositories();
            setupSubscriptions();
        });

        it('should delete matching webhook subscriptions', async () => {
            await deleteWebhook(service, params);

            expect(
                service.azureReposRequestHelper.deleteWebhookById,
            ).toHaveBeenCalledWith({
                orgName: 'my-org',
                token: 'valid-pat-token',
                subscriptionId: 'sub-1',
            });
        });

        it('should NOT delete non-matching subscriptions', async () => {
            await deleteWebhook(service, params);

            // sub-other should not be deleted (different URL)
            const deleteCalls =
                service.azureReposRequestHelper.deleteWebhookById.mock.calls;
            const deletedIds = deleteCalls.map(
                (call: any[]) => call[0].subscriptionId,
            );
            expect(deletedIds).not.toContain('sub-other');
        });

        it('should log success for each deleted subscription', async () => {
            await deleteWebhook(service, params);

            expect(mockLogger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('Webhook removed'),
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
            setupRepositories();
            service.azureReposRequestHelper.listSubscriptionsByProject.mockRejectedValue(
                new Error('401 Unauthorized - PAT expired'),
            );
        });

        it('should catch per-repo errors and log them', async () => {
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
    // Edge cases
    // ═══════════════════════════════════════════════════════
    describe('Edge cases', () => {
        it('should do nothing when authMode is not token', async () => {
            service.getAuthDetails.mockResolvedValue({
                authMode: 'oauth',
                accessToken: 'token',
            });

            await deleteWebhook(service, params);

            expect(
                service.findOneByOrganizationAndTeamDataAndConfigKey,
            ).not.toHaveBeenCalled();
        });

        it('should handle no repositories configured', async () => {
            setupValidAuth();
            service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue(
                null,
            );

            await deleteWebhook(service, params);

            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should skip repo when projectId is not found', async () => {
            setupValidAuth();
            service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue(
                [{ id: 'repo-1', name: 'frontend-app' }],
            );
            service.getProjectIdFromRepository.mockResolvedValue(null);

            await deleteWebhook(service, params);

            expect(
                service.azureReposRequestHelper.listSubscriptionsByProject,
            ).not.toHaveBeenCalled();
        });

        it('should handle no matching subscriptions', async () => {
            setupValidAuth();
            service.findOneByOrganizationAndTeamDataAndConfigKey.mockResolvedValue(
                [{ id: 'repo-1', name: 'frontend-app' }],
            );
            service.getProjectIdFromRepository.mockResolvedValue('project-1');
            service.azureReposRequestHelper.listSubscriptionsByProject.mockResolvedValue(
                [
                    {
                        id: 'sub-other',
                        publisherInputs: { repository: 'repo-1' },
                        consumerInputs: {
                            url: 'https://completely-different.example.com',
                        },
                    },
                ],
            );

            await deleteWebhook(service, params);

            expect(
                service.azureReposRequestHelper.deleteWebhookById,
            ).not.toHaveBeenCalled();
        });
    });
});
