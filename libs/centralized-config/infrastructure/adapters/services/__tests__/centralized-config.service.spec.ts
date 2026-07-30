import { createLogger } from '@libs/core/log/logger';
import { Test, TestingModule } from '@nestjs/testing';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { IConfigFileMeta } from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { DeleteRepositoryCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/delete-repository-code-review-parameter.use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { CreateOrUpdatePullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import { PULL_REQUEST_MESSAGES_SERVICE_TOKEN } from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import { KODY_RULES_SERVICE_TOKEN } from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import * as yaml from 'js-yaml';
import { CentralizedConfigService } from '../centralized-config.service';

describe('CentralizedConfigService', () => {
    let service: CentralizedConfigService;
    let mockParametersService: any;
    let mockIntegrationConfigService: any;
    let mockCodeManagementService: any;
    let mockUpdateOrCreateCodeReviewParameterUseCase: any;
    let mockDeleteRepositoryCodeReviewParameterUseCase: any;
    let mockCreateOrUpdateParametersUseCase: any;
    let mockCreateOrUpdatePullRequestMessagesUseCase: any;
    let mockPullRequestMessagesService: any;
    let mockCodeBaseConfigService: any;
    let mockCreateOrUpdateKodyRulesUseCase: any;
    let mockDeleteRuleInOrganizationByIdKodyRulesUseCase: any;
    let mockKodyRulesService: any;

    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const actor = {
        organizationId: 'org-1',
        source: 'sync' as const,
        userEmail: 'kody@kodus.io',
        userId: 'kody',
    };

    beforeEach(async () => {
        mockParametersService = {
            findByKey: jest.fn(),
            findOne: jest.fn(),
        };

        mockIntegrationConfigService = {
            findIntegrationConfigFormatted: jest.fn(),
        };

        mockCodeManagementService = {
            getRepositoryTree: jest.fn(),
            getRepositoryContentFile: jest.fn(),
            getDefaultBranch: jest.fn(),
        };

        mockUpdateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn(),
        };

        mockDeleteRepositoryCodeReviewParameterUseCase = {
            execute: jest.fn(),
        };

        mockCreateOrUpdateParametersUseCase = {
            execute: jest.fn(),
        };

        mockCreateOrUpdatePullRequestMessagesUseCase = {
            execute: jest.fn(),
        };

        mockPullRequestMessagesService = {
            findOne: jest.fn(),
            find: jest.fn(),
            delete: jest.fn(),
        };

        mockCodeBaseConfigService = {
            getKodusConfigFile: jest.fn(),
            getDirectoryIdForPath: jest.fn(),
        };

        mockCreateOrUpdateKodyRulesUseCase = {
            execute: jest.fn(),
        };

        mockDeleteRuleInOrganizationByIdKodyRulesUseCase = {
            execute: jest.fn(),
        };

        mockKodyRulesService = {
            find: jest.fn(),
            findByOrganizationId: jest.fn(),
            updateRulesStatusByFilter: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CentralizedConfigService,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: UpdateOrCreateCodeReviewParameterUseCase,
                    useValue: mockUpdateOrCreateCodeReviewParameterUseCase,
                },
                {
                    provide: DeleteRepositoryCodeReviewParameterUseCase,
                    useValue: mockDeleteRepositoryCodeReviewParameterUseCase,
                },
                {
                    provide: CreateOrUpdateParametersUseCase,
                    useValue: mockCreateOrUpdateParametersUseCase,
                },
                {
                    provide: CreateOrUpdatePullRequestMessagesUseCase,
                    useValue: mockCreateOrUpdatePullRequestMessagesUseCase,
                },
                {
                    provide: PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
                    useValue: mockPullRequestMessagesService,
                },
                {
                    provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                    useValue: mockCodeBaseConfigService,
                },
                {
                    provide: CreateOrUpdateKodyRulesUseCase,
                    useValue: mockCreateOrUpdateKodyRulesUseCase,
                },
                {
                    provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                    useValue: mockDeleteRuleInOrganizationByIdKodyRulesUseCase,
                },
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: mockKodyRulesService,
                },
            ],
        }).compile();

        service = module.get<CentralizedConfigService>(
            CentralizedConfigService,
        );

        // Mock the logger to avoid console output during tests
        jest.spyOn(createLogger(''), 'log').mockImplementation(() => {});
        jest.spyOn(createLogger(''), 'error').mockImplementation(() => {});
        jest.spyOn(createLogger(''), 'warn').mockImplementation(() => {});
    });

    describe('synchronizeConfigs', () => {
        it('should sync custom messages from centralized config', async () => {
            const configFiles: IConfigFileMeta[] = [
                {
                    repositoryId: 'repo-1',
                    centralizedDirectoryPath: 'repo1',
                    directoryPath: '/src',
                },
            ];

            const configFileWithCustomMessages = {
                version: '2.0',
                automatedReviewActive: true,
                customMessages: {
                    globalSettings: {
                        hideComments: false,
                        suggestionCopyPrompt: true,
                    },
                    startReviewMessage: {
                        status: 'every_push',
                        content: 'Custom start message',
                    },
                    endReviewMessage: {
                        status: 'every_push',
                        content: 'Custom end message',
                    },
                },
            };

            // Mock repository lookup
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [{ id: 'repo-1', name: 'repo1', full_name: 'org/repo1' }],
            );

            // Mock directory ID resolution
            mockCodeBaseConfigService.getDirectoryIdForPath.mockResolvedValue(
                'dir-1',
            );

            // Mock existing parent configs (empty for this test)
            mockPullRequestMessagesService.findOne.mockResolvedValue(null);

            // Mock config file fetch
            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                configFileWithCustomMessages,
            );

            // Mock parameter operations - different mocks for different keys
            mockParametersService.findByKey.mockImplementation(
                (key, _orgAndTeamData) => {
                    if (key === ParametersKey.CENTRALIZED_CONFIG) {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                                repository: {
                                    id: 'centralized-repo-1',
                                    name: 'centralized-repo',
                                },
                            },
                        });
                    }
                    if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                        return Promise.resolve({
                            configValue: {},
                        });
                    }
                    return Promise.resolve({
                        configValue: {},
                    });
                },
            );

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockCreateOrUpdatePullRequestMessagesUseCase.execute,
            ).toHaveBeenCalledWith(
                {
                    uuid: 'kody',
                    email: 'kody@kodus.io',
                    organization: { uuid: 'org-1' },
                },
                {
                    organizationId: 'org-1',
                    configLevel: ConfigLevel.DIRECTORY,
                    repositoryId: 'repo-1',
                    directoryId: 'dir-1',
                    startReviewMessage: {
                        status: 'every_push',
                        content: 'Custom start message',
                    },
                    endReviewMessage: {
                        status: 'every_push',
                        content: 'Custom end message',
                    },
                    errorReviewMessage: {
                        status: 'off',
                        content: '',
                    },
                    globalSettings: {
                        hideComments: false,
                        suggestionCopyPrompt: true,
                    },
                },
                {
                    skipAuthorization: true,
                    skipCentralizedPr: true,
                },
            );

            // Verify customMessages are removed from the config stored in Postgres
            expect(
                mockUpdateOrCreateCodeReviewParameterUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    configValue: expect.not.objectContaining({
                        customMessages: expect.anything(),
                    }),
                }),
            );
        });

        it('should handle global config custom messages', async () => {
            const configFiles: IConfigFileMeta[] = [{}]; // Global config

            const configFileWithCustomMessages = {
                version: '2.0',
                automatedReviewActive: true,
                customMessages: {
                    globalSettings: {
                        hideComments: true,
                        suggestionCopyPrompt: false,
                    },
                    startReviewMessage: {
                        status: 'only_when_opened',
                        content: 'Global start message',
                    },
                    endReviewMessage: {
                        status: 'off',
                        content: '',
                    },
                },
            };

            // Mock config file fetch
            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                configFileWithCustomMessages,
            );

            // Mock parameter operations - different mocks for different keys
            mockParametersService.findByKey.mockImplementation(
                (key, _orgAndTeamData) => {
                    if (key === ParametersKey.CENTRALIZED_CONFIG) {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                                repository: {
                                    id: 'centralized-repo-1',
                                    name: 'centralized-repo',
                                },
                            },
                        });
                    }
                    if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                        return Promise.resolve({
                            configValue: {},
                        });
                    }
                    return Promise.resolve({
                        configValue: {},
                    });
                },
            );

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockCreateOrUpdatePullRequestMessagesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.any(Object),
                {
                    organizationId: 'org-1',
                    configLevel: ConfigLevel.GLOBAL,
                    repositoryId: 'global',
                    directoryId: undefined,
                    startReviewMessage: {
                        status: 'only_when_opened',
                        content: 'Global start message',
                    },
                    endReviewMessage: {
                        status: 'off',
                        content: '',
                    },
                    errorReviewMessage: {
                        status: 'off',
                        content: '',
                    },
                    globalSettings: {
                        hideComments: true,
                        suggestionCopyPrompt: false,
                    },
                },
                {
                    skipAuthorization: true,
                    skipCentralizedPr: true,
                },
            );
        });

        it('should sync config file with only custom messages', async () => {
            const configFiles: IConfigFileMeta[] = [{}]; // Global config

            const configFileWithOnlyCustomMessages = {
                customMessages: {
                    globalSettings: {
                        hideComments: false,
                        suggestionCopyPrompt: true,
                    },
                    startReviewMessage: {
                        status: 'every_push',
                        content: 'Custom start message',
                    },
                    endReviewMessage: {
                        status: 'every_push',
                        content: 'Custom end message',
                    },
                },
            };

            // Mock config file fetch
            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                configFileWithOnlyCustomMessages,
            );

            // Mock parameter operations - different mocks for different keys
            mockParametersService.findByKey.mockImplementation(
                (key, _orgAndTeamData) => {
                    if (key === ParametersKey.CENTRALIZED_CONFIG) {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                                repository: {
                                    id: 'centralized-repo-1',
                                    name: 'centralized-repo',
                                },
                            },
                        });
                    }
                    if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                        return Promise.resolve({
                            configValue: {},
                        });
                    }
                    return Promise.resolve({
                        configValue: {},
                    });
                },
            );

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockCreateOrUpdatePullRequestMessagesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.any(Object),
                {
                    organizationId: 'org-1',
                    configLevel: ConfigLevel.GLOBAL,
                    repositoryId: 'global',
                    directoryId: undefined,
                    startReviewMessage: {
                        status: 'every_push',
                        content: 'Custom start message',
                    },
                    endReviewMessage: {
                        status: 'every_push',
                        content: 'Custom end message',
                    },
                    errorReviewMessage: {
                        status: 'off',
                        content: '',
                    },
                    globalSettings: {
                        hideComments: false,
                        suggestionCopyPrompt: true,
                    },
                },
                {
                    skipAuthorization: true,
                    skipCentralizedPr: true,
                },
            );

            // Verify that customMessages are removed and only an empty config is stored in Postgres
            expect(
                mockUpdateOrCreateCodeReviewParameterUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    configValue: {},
                }),
            );
        });

        it('should skip custom messages sync when customMessages is not present', async () => {
            const configFiles: IConfigFileMeta[] = [{}];

            const configFileWithoutCustomMessages = {
                version: '2.0',
                automatedReviewActive: true,
            };

            // Mock config file fetch
            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                configFileWithoutCustomMessages,
            );

            // Mock parameter operations - different mocks for different keys
            mockParametersService.findByKey.mockImplementation(
                (key, _orgAndTeamData) => {
                    if (key === ParametersKey.CENTRALIZED_CONFIG) {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                                repository: {
                                    id: 'centralized-repo-1',
                                    name: 'centralized-repo',
                                },
                            },
                        });
                    }
                    if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                        return Promise.resolve({
                            configValue: {},
                        });
                    }
                    return Promise.resolve({
                        configValue: {},
                    });
                },
            );

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockCreateOrUpdatePullRequestMessagesUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it('should handle errors in custom messages sync gracefully', async () => {
            const configFiles: IConfigFileMeta[] = [{}];

            const configFileWithCustomMessages = {
                version: '2.0',
                automatedReviewActive: true,
                customMessages: {
                    globalSettings: {
                        hideComments: false,
                        suggestionCopyPrompt: true,
                    },
                    startReviewMessage: {
                        status: 'every_push',
                        content: 'Custom start message',
                    },
                    endReviewMessage: {
                        status: 'every_push',
                        content: 'Custom end message',
                    },
                },
            };

            // Mock config file fetch
            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                configFileWithCustomMessages,
            );

            // Mock parameter operations - different mocks for different keys
            mockParametersService.findByKey.mockImplementation(
                (key, _orgAndTeamData) => {
                    if (key === ParametersKey.CENTRALIZED_CONFIG) {
                        return Promise.resolve({
                            configValue: {
                                enabled: true,
                                repository: {
                                    id: 'centralized-repo-1',
                                    name: 'centralized-repo',
                                },
                            },
                        });
                    }
                    if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                        return Promise.resolve({
                            configValue: {},
                        });
                    }
                    return Promise.resolve({
                        configValue: {},
                    });
                },
            );

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            // Mock custom messages sync to fail
            mockCreateOrUpdatePullRequestMessagesUseCase.execute.mockRejectedValue(
                new Error('Custom messages sync failed'),
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            // Should still succeed because custom messages errors don't fail the whole sync
            expect(result.success).toBe(true);
            expect(result.message).toBe(
                'Config files synchronized successfully',
            );
        });

        it('should create empty config placeholders for rule-only scopes', async () => {
            const configFiles: IConfigFileMeta[] = [
                {
                    repositoryId: 'repo-1',
                    directoryPath: '/src',
                    centralizedDirectoryPath: 'repo-1/src/.kody-rules/review',
                },
            ];

            mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue(
                null,
            );

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [{ id: 'repo-1', name: 'repo-1', full_name: 'org/repo-1' }],
            );

            mockCodeBaseConfigService.getDirectoryIdForPath.mockResolvedValue(
                'dir-1',
            );

            mockPullRequestMessagesService.findOne.mockResolvedValue({
                uuid: 'message-1',
            });

            mockParametersService.findByKey.mockImplementation((key) => {
                if (key === ParametersKey.CENTRALIZED_CONFIG) {
                    return Promise.resolve({
                        configValue: {
                            enabled: true,
                            repository: {
                                id: 'centralized-repo-1',
                                name: 'centralized-repo',
                            },
                        },
                    });
                }

                if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                    return Promise.resolve({
                        configValue: {},
                    });
                }

                return Promise.resolve({
                    configValue: {},
                });
            });

            mockUpdateOrCreateCodeReviewParameterUseCase.execute.mockResolvedValue(
                undefined,
            );

            const result = await service.synchronizeConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockUpdateOrCreateCodeReviewParameterUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    configValue: {},
                    repositoryId: 'repo-1',
                    directoryPath: '/src',
                }),
            );
            expect(
                mockCreateOrUpdatePullRequestMessagesUseCase.execute,
            ).not.toHaveBeenCalled();
            expect(mockPullRequestMessagesService.delete).toHaveBeenCalledWith(
                'message-1',
            );
        });
    });

    describe('removeStaleConfigs', () => {
        it('should remove stale custom messages even when regular config does not change', async () => {
            // Non-empty discovery (a repo scope) so the #1518 empty-discovery
            // guard does not trigger; the GLOBAL message is stale because no
            // global config file was discovered.
            const configFiles: IConfigFileMeta[] = [
                { repositoryId: 'repo-1' } as any,
            ];

            const codeReviewConfig = {
                configValue: {
                    configs: {},
                    repositories: [],
                },
            };

            mockParametersService.findByKey.mockImplementation((key) => {
                if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                    return Promise.resolve(codeReviewConfig);
                }

                return Promise.resolve({ configValue: {} });
            });

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );

            mockPullRequestMessagesService.find.mockResolvedValue([
                {
                    uuid: 'global-message-1',
                    configLevel: ConfigLevel.GLOBAL,
                },
            ]);

            const result = await service.removeStaleConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(result.message).toBe('No stale configs to remove');
            expect(mockPullRequestMessagesService.delete).toHaveBeenCalledWith(
                'global-message-1',
            );
            // The code review config itself must not be rewritten. Sync does
            // record its managed-repository baseline (#1579), but that lives
            // under CENTRALIZED_CONFIG — a different key.
            expect(
                mockCreateOrUpdateParametersUseCase.execute,
            ).not.toHaveBeenCalledWith(
                ParametersKey.CODE_REVIEW_CONFIG,
                expect.anything(),
                expect.anything(),
            );
        });
    });

    // ---------------------------------------------------------------------
    // Issue #1518 — empty/failed discovery must NOT wipe data. A read failure
    // (repositories mapping unavailable, tree read failed) yields the same
    // empty result as a genuinely empty repo, and the non-transactional
    // reconcile then deleted every rule and reset the org's global config
    // (default model / BYOK) plus custom messages. These assert the SAFE
    // post-guard behavior and are the regression coverage for the fix.
    // ---------------------------------------------------------------------
    describe('#1518 empty-discovery wipe guard', () => {
        it('discoverKodyRulesFiles THROWS (not []) when the repositories mapping cannot be loaded', async () => {
            mockCodeManagementService.getRepositoryTree.mockResolvedValue([
                { type: 'file', path: 'my-repo/.kody-rules/review/a.yml' },
            ]);
            // Transient integration-config read failure → null (a FAILURE, not
            // "zero files"). Must surface so the sync aborts before deletion.
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                null,
            );

            await expect(
                service.discoverKodyRulesFiles({
                    organizationAndTeamData,
                    repository: { name: 'config-repo', id: 'repo-1' },
                }),
            ).rejects.toThrow();
        });

        it('discoverConfigFiles THROWS (not []) when the repositories mapping cannot be loaded', async () => {
            // Twin of discoverKodyRulesFiles — both go through scanRepositoryTree,
            // and both feed removeStale*, so both must fail loudly on a read error.
            mockCodeManagementService.getRepositoryTree.mockResolvedValue([
                { type: 'file', path: 'my-repo/kodus-config.yml' },
            ]);
            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                null,
            );

            await expect(
                service.discoverConfigFiles({
                    organizationAndTeamData,
                    repository: { name: 'config-repo', id: 'repo-1' },
                }),
            ).rejects.toThrow();
        });

        it('removeStaleKodyRules does NOT delete centralized rules when discovery is empty', async () => {
            const ruleFiles: any[] = []; // empty discovery

            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                toJson: () => ({
                    rules: [
                        {
                            uuid: 'r1',
                            title: 'A',
                            centralizedConfig: {
                                path: '.kody-rules/review/a.yml',
                            },
                        },
                        {
                            uuid: 'r2',
                            title: 'B',
                            centralizedConfig: {
                                path: '.kody-rules/review/b.yml',
                            },
                        },
                    ],
                }),
            });

            const result = await service.removeStaleKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(result.removedRuleCount).toBe(0);
            expect(
                mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it('removeStaleConfigs does NOT reset global config / delete repo configs / delete messages when discovery is empty', async () => {
            const configFiles: IConfigFileMeta[] = []; // empty discovery

            const codeReviewConfig = {
                configValue: {
                    // org-wide defaults: LLM provider + model + BYOK reference
                    configs: {
                        llmProvider: 'openai_byok',
                        byokConfig: { apiKey: 'sk-live-secret' },
                    },
                    repositories: [
                        {
                            id: 'repo-1',
                            isSelected: true,
                            configs: { reviewOptions: { security: true } },
                            directories: [],
                        },
                    ],
                },
            };

            mockParametersService.findByKey.mockImplementation((key: any) =>
                key === ParametersKey.CODE_REVIEW_CONFIG
                    ? Promise.resolve(codeReviewConfig)
                    : Promise.resolve({ configValue: {} }),
            );
            mockPullRequestMessagesService.find.mockResolvedValue([
                { uuid: 'global-message-1', configLevel: ConfigLevel.GLOBAL },
            ]);

            const result = await service.removeStaleConfigs({
                organizationAndTeamData,
                configFiles,
                actor,
            });

            expect(result.success).toBe(true);
            // None of the destructive paths may fire on empty discovery.
            expect(
                mockCreateOrUpdateParametersUseCase.execute,
            ).not.toHaveBeenCalled();
            expect(
                mockDeleteRepositoryCodeReviewParameterUseCase.execute,
            ).not.toHaveBeenCalled();
            expect(
                mockPullRequestMessagesService.delete,
            ).not.toHaveBeenCalled();
        });
    });

    // Backfill for the four methods that had no direct unit test — the gap
    // that let #1518 through (methods only exercised via mocks in the use-case
    // spec, never their own logic).
    describe('untested method coverage', () => {
        describe('validateCentralizedConfig', () => {
            it('fails when centralized config is not enabled', async () => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: { enabled: false },
                });
                const r = await service.validateCentralizedConfig({
                    organizationAndTeamData,
                });
                expect(r.success).toBe(false);
                expect(r.message).toContain('not enabled');
            });

            it('fails when enabled but no repository is configured', async () => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: { enabled: true, repository: {} },
                });
                const r = await service.validateCentralizedConfig({
                    organizationAndTeamData,
                });
                expect(r.success).toBe(false);
                expect(r.message).toContain('no repository');
            });

            it('succeeds when enabled and a repository is configured', async () => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: {
                        enabled: true,
                        repository: { id: 'r1', name: 'kodus' },
                    },
                });
                const r = await service.validateCentralizedConfig({
                    organizationAndTeamData,
                });
                expect(r.success).toBe(true);
            });
        });

        describe('getCentralizedConfigRepository', () => {
            it('returns the configured repository', async () => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: { repository: { id: 'r1', name: 'kodus' } },
                });
                const repo =
                    await service.getCentralizedConfigRepository(
                        organizationAndTeamData,
                    );
                expect(repo).toEqual({ id: 'r1', name: 'kodus' });
            });

            it('throws when no repository is configured', async () => {
                mockParametersService.findByKey.mockResolvedValue({
                    configValue: {},
                });
                await expect(
                    service.getCentralizedConfigRepository(
                        organizationAndTeamData,
                    ),
                ).rejects.toThrow(
                    'Centralized config repository not configured',
                );
            });
        });

        describe('fetchConfigFile', () => {
            it('returns the config file on success', async () => {
                mockCodeBaseConfigService.getKodusConfigFile.mockResolvedValue({
                    version: 2,
                });
                const file = await service.fetchConfigFile({
                    organizationAndTeamData,
                    repository: { name: 'r', id: 'r1' },
                });
                expect(file).toEqual({ version: 2 });
            });

            it('returns null (does not throw) when the read fails', async () => {
                mockCodeBaseConfigService.getKodusConfigFile.mockRejectedValue(
                    new Error('boom'),
                );
                const file = await service.fetchConfigFile({
                    organizationAndTeamData,
                    repository: { name: 'r', id: 'r1' },
                });
                expect(file).toBeNull();
            });
        });

        describe('fetchKodyRuleFile', () => {
            it('returns null when the file has no content', async () => {
                mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                    'main',
                );
                mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                    { data: {} },
                );
                const rule = await service.fetchKodyRuleFile({
                    organizationAndTeamData,
                    repository: { name: 'r', id: 'r1' },
                    filePath: '.kody-rules/review/a.yml',
                });
                expect(rule).toBeNull();
            });

            it('decodes and parses a base64 YAML rule file', async () => {
                mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                    'main',
                );
                const yamlContent = 'title: My rule\nrule: do the thing\n';
                mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                    {
                        data: {
                            content: Buffer.from(
                                yamlContent,
                                'utf-8',
                            ).toString('base64'),
                            encoding: 'base64',
                        },
                    },
                );
                const rule = await service.fetchKodyRuleFile({
                    organizationAndTeamData,
                    repository: { name: 'r', id: 'r1' },
                    filePath: '.kody-rules/review/a.yml',
                });
                expect(rule).toMatchObject({ title: 'My rule' });
            });
        });
    });

    describe('discoverKodyRulesFiles', () => {
        it('should discover Kody rule files from centralized repository', async () => {
            const mockRepoTree = [
                {
                    path: 'kodus-config.yml',
                    type: 'file' as const,
                },
                {
                    path: '.kody-rules/memories/logging.yml',
                    type: 'file' as const,
                },
                {
                    path: '.kody-rules/review/security.yml',
                    type: 'file' as const,
                },
                {
                    path: 'org-a/.kody-rules/memories/auth.yml',
                    type: 'file' as const,
                },
                {
                    path: 'org-a/services%2Fapi/.kody-rules/review/api.yml',
                    type: 'file' as const,
                },
            ];

            mockCodeManagementService.getRepositoryTree.mockResolvedValue(
                mockRepoTree,
            );

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [{ id: 'org-a-id', name: 'org-a', full_name: 'org-a' }],
            );

            const result = await service.discoverKodyRulesFiles({
                organizationAndTeamData,
                repository: { name: 'central-repo', id: 'central-repo-id' },
            });

            expect(result).toHaveLength(4);
            expect(result).toEqual(
                expect.arrayContaining([
                    {
                        centralizedDirectoryPath: '.kody-rules/memories',
                        repositoryId: undefined,
                        directoryPath: undefined,
                        directoryPaths: undefined,
                        ruleType: 'memory' as any,
                        ruleFilePath: '.kody-rules/memories/logging.yml',
                        path: '.kody-rules/memories/logging.yml',
                    },
                    {
                        centralizedDirectoryPath: '.kody-rules/review',
                        repositoryId: undefined,
                        directoryPath: undefined,
                        directoryPaths: undefined,
                        ruleType: 'standard' as any,
                        ruleFilePath: '.kody-rules/review/security.yml',
                        path: '.kody-rules/review/security.yml',
                    },
                    {
                        centralizedDirectoryPath: 'org-a/.kody-rules/memories',
                        repositoryId: 'org-a-id',
                        directoryPath: undefined,
                        directoryPaths: undefined,
                        ruleType: 'memory' as any,
                        ruleFilePath: 'org-a/.kody-rules/memories/auth.yml',
                        path: 'org-a/.kody-rules/memories/auth.yml',
                    },
                    {
                        centralizedDirectoryPath:
                            'org-a/services%2Fapi/.kody-rules/review',
                        repositoryId: 'org-a-id',
                        directoryPath: '/services/api',
                        directoryPaths: ['/services/api'],
                        ruleType: 'standard' as any,
                        ruleFilePath:
                            'org-a/services%2Fapi/.kody-rules/review/api.yml',
                        path: 'org-a/services%2Fapi/.kody-rules/review/api.yml',
                    },
                ]),
            );
        });

        it('should exclude files not in .kody-rules directories', async () => {
            const mockRepoTree = [
                {
                    path: 'kodus-config.yml',
                    type: 'file' as const,
                },
                {
                    path: 'rules.yml',
                    type: 'file' as const,
                },
                {
                    path: '.kody-rules/memories/logging.yml',
                    type: 'file' as const,
                },
            ];

            mockCodeManagementService.getRepositoryTree.mockResolvedValue(
                mockRepoTree,
            );

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );

            const result = await service.discoverKodyRulesFiles({
                organizationAndTeamData,
                repository: { name: 'central-repo', id: 'central-repo-id' },
            });

            expect(result).toHaveLength(1);
            expect(result[0].ruleFilePath).toBe(
                '.kody-rules/memories/logging.yml',
            );
        });
    });

    describe('synchronizeKodyRules', () => {
        it('should synchronize Kody rules successfully', async () => {
            const ruleFiles: any[] = [
                {
                    centralizedDirectoryPath: '.kody-rules/memories',
                    repositoryId: undefined,
                    directoryPath: undefined,
                    ruleType: 'memory' as any,
                    ruleFilePath: '.kody-rules/memories/logging.yml',
                    path: '.kody-rules/memories/logging.yml',
                },
            ];

            const mockRuleContent = {
                title: 'Logging Rule',
                rule: 'Use structured logging',
                examples: [
                    { snippet: 'console.log("test")', isCorrect: false },
                ],
                inheritance: { inheritable: true, exclude: [], include: [] },
            };

            mockCodeManagementService.getRepositoryTree.mockResolvedValue([]);
            mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                'main',
            );
            mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                {
                    data: {
                        content: Buffer.from(
                            yaml.dump(mockRuleContent),
                        ).toString('base64'),
                        encoding: 'base64',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    repository: { name: 'central-repo', id: 'central-repo-id' },
                },
            });

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                rules: [],
            });
            mockCreateOrUpdateKodyRulesUseCase.execute.mockResolvedValue({
                uuid: 'rule-uuid',
            });

            const result = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(result.message).toContain(
                'Kody rules synchronized successfully',
            );
            expect(result.syncedRuleCount).toBe(1);
            expect(
                mockCreateOrUpdateKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Logging Rule',
                    rule: 'Use structured logging',
                    type: 'memory',
                    status: 'active',
                    repositoryId: 'global',
                    centralizedConfig: {
                        path: '.kody-rules/memories/logging.yml',
                        status: 'synced',
                    },
                }),
                'org-1',
                expect.any(Object),
                true,
            );
        });

        it('should update existing pending rule when sourcePath matches', async () => {
            const ruleFiles: any[] = [
                {
                    centralizedDirectoryPath: '.kody-rules/review',
                    repositoryId: undefined,
                    directoryPath: undefined,
                    ruleType: 'standard' as any,
                    ruleFilePath: '.kody-rules/review/security.yml',
                    path: '.kody-rules/review/security.yml',
                },
            ];

            const mockRuleContent = {
                title: 'Security Rule',
                rule: 'Never expose secrets',
                examples: [],
                inheritance: { inheritable: true, exclude: [], include: [] },
            };

            mockCodeManagementService.getRepositoryTree.mockResolvedValue([]);
            mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                'main',
            );
            mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                {
                    data: {
                        content: Buffer.from(
                            yaml.dump(mockRuleContent),
                        ).toString('base64'),
                        encoding: 'base64',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    repository: { name: 'central-repo', id: 'central-repo-id' },
                },
            });

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                rules: [
                    {
                        uuid: 'pending-rule-uuid',
                        status: 'pending',
                        origin: 'past_reviews',
                        centralizedConfig: {
                            path: '.kody-rules/review/security.yml',
                            status: 'pending_edit',
                        },
                    },
                ],
            });
            mockCreateOrUpdateKodyRulesUseCase.execute.mockResolvedValue({
                uuid: 'pending-rule-uuid',
            });

            const result = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            expect(result.success).toBe(true);
            // Sync must NOT auto-approve a rule that is awaiting approval, and
            // must not reclassify its origin — otherwise merging the
            // centralized-config PR silently approves every pending rule.
            expect(
                mockCreateOrUpdateKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    uuid: 'pending-rule-uuid',
                    centralizedConfig: {
                        path: '.kody-rules/review/security.yml',
                        status: 'synced',
                    },
                    status: 'pending',
                    origin: 'past_reviews',
                }),
                'org-1',
                expect.any(Object),
                true,
            );
        });

        it('should NOT resurrect a rejected rule when sourcePath matches', async () => {
            const ruleFiles: any[] = [
                {
                    centralizedDirectoryPath: '.kody-rules/review',
                    repositoryId: undefined,
                    directoryPath: undefined,
                    ruleType: 'standard' as any,
                    ruleFilePath: '.kody-rules/review/rejected.yml',
                    path: '.kody-rules/review/rejected.yml',
                },
            ];

            const mockRuleContent = {
                title: 'Rejected Rule',
                rule: 'Should stay hidden',
                examples: [],
                inheritance: { inheritable: true, exclude: [], include: [] },
            };

            mockCodeManagementService.getRepositoryTree.mockResolvedValue([]);
            mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                'main',
            );
            mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                {
                    data: {
                        content: Buffer.from(
                            yaml.dump(mockRuleContent),
                        ).toString('base64'),
                        encoding: 'base64',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    repository: { name: 'central-repo', id: 'central-repo-id' },
                },
            });

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                rules: [
                    {
                        uuid: 'rejected-rule-uuid',
                        status: 'rejected',
                        centralizedConfig: {
                            path: '.kody-rules/review/rejected.yml',
                            status: 'synced',
                        },
                    },
                ],
            });
            mockCreateOrUpdateKodyRulesUseCase.execute.mockResolvedValue({
                uuid: 'rejected-rule-uuid',
            });

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            expect(
                mockCreateOrUpdateKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    uuid: 'rejected-rule-uuid',
                    status: 'rejected',
                }),
                'org-1',
                expect.any(Object),
                true,
            );
        });

        it('should update existing active rule when sourcePath matches', async () => {
            const ruleFiles: any[] = [
                {
                    centralizedDirectoryPath: '.kody-rules/review',
                    repositoryId: undefined,
                    directoryPath: undefined,
                    ruleType: 'standard' as any,
                    ruleFilePath: '.kody-rules/review/style.yml',
                    path: '.kody-rules/review/style.yml',
                },
            ];

            const mockRuleContent = {
                title: 'Style Rule',
                rule: 'Prefer const over let',
                examples: [],
                inheritance: { inheritable: true, exclude: [], include: [] },
            };

            mockCodeManagementService.getRepositoryTree.mockResolvedValue([]);
            mockCodeManagementService.getDefaultBranch.mockResolvedValue(
                'main',
            );
            mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                {
                    data: {
                        content: Buffer.from(
                            yaml.dump(mockRuleContent),
                        ).toString('base64'),
                        encoding: 'base64',
                    },
                },
            );

            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    repository: { name: 'central-repo', id: 'central-repo-id' },
                },
            });

            mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
                [],
            );
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                rules: [
                    {
                        uuid: 'active-rule-uuid',
                        status: 'active',
                        centralizedConfig: {
                            path: '.kody-rules/review/style.yml',
                            status: 'synced',
                        },
                    },
                ],
            });
            mockCreateOrUpdateKodyRulesUseCase.execute.mockResolvedValue({
                uuid: 'active-rule-uuid',
            });

            const result = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            expect(result.success).toBe(true);
            expect(
                mockCreateOrUpdateKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    uuid: 'active-rule-uuid',
                    centralizedConfig: {
                        path: '.kody-rules/review/style.yml',
                        status: 'synced',
                    },
                    status: 'active',
                }),
                'org-1',
                expect.any(Object),
                true,
            );
        });

        it('should handle YAML parsing errors gracefully', async () => {
            const ruleFiles: any[] = [
                {
                    centralizedDirectoryPath: '.kody-rules/memories',
                    ruleFilePath: '.kody-rules/memories/invalid.yml',
                    path: '.kody-rules/memories/invalid.yml',
                    ruleType: 'memory' as any,
                },
            ];

            mockParametersService.findByKey.mockResolvedValue({
                configValue: {
                    repository: { name: 'central-repo', id: 'central-repo-id' },
                },
            });
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                rules: [],
            });

            mockCodeManagementService.getRepositoryContentFile.mockResolvedValue(
                {
                    data: {
                        content: Buffer.from('invalid: yaml: content: ['), // Invalid YAML
                        encoding: 'base64',
                    },
                },
            );

            const result = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles,
                actor,
            });

            // #1518: a per-file failure must NOT be reported as an overall
            // success — the sync is incomplete and the caller has to know.
            expect(result.success).toBe(false);
            expect(result.message).toContain('incomplete');
            expect(result.failureDetails).toHaveLength(1);
            expect(result.failureDetails![0].file).toBe(
                '.kody-rules/memories/invalid.yml',
            );
        });
    });

    describe('removeStaleKodyRules', () => {
        it('should remove stale centralized rules not present in centralized files', async () => {
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                toJson: () => ({
                    rules: [
                        {
                            uuid: 'pending-merge-rule-1',
                            title: 'Pending merge rule',
                            status: 'active',
                            centralizedConfig: {
                                path: '.kody-rules/review/pending.yml',
                                status: 'pending_delete',
                            },
                        },
                    ],
                }),
            });

            mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute.mockResolvedValue(
                true,
            );

            const result = await service.removeStaleKodyRules({
                organizationAndTeamData,
                actor,
                // Non-empty discovery (a real file list that just doesn't
                // include pending.yml) so the #1518 empty-discovery guard does
                // not trigger — this validates genuine stale removal.
                ruleFiles: [
                    { path: '.kody-rules/review/other.yml' } as any,
                ],
            });

            expect(result.success).toBe(true);
            expect(
                mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith('pending-merge-rule-1', actor);
        });

        it('should NOT delete rules that were never part of the centralized config', async () => {
            // Pending/rejected/manual rules have no centralizedConfig.path —
            // they aren't exported, so the stale-cleanup must leave them alone
            // instead of treating a missing path as "stale".
            mockKodyRulesService.findByOrganizationId.mockResolvedValue({
                toJson: () => ({
                    rules: [
                        { uuid: 'pending-rule', status: 'pending' },
                        { uuid: 'rejected-rule', status: 'rejected' },
                        {
                            uuid: 'manual-rule',
                            status: 'active',
                            centralizedConfig: null,
                        },
                        {
                            uuid: 'synced-rule',
                            status: 'active',
                            centralizedConfig: {
                                path: '.kody-rules/review/kept.yml',
                                status: 'synced',
                            },
                        },
                    ],
                }),
            });

            mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute.mockResolvedValue(
                true,
            );

            const result = await service.removeStaleKodyRules({
                organizationAndTeamData,
                actor,
                ruleFiles: [
                    { path: '.kody-rules/review/kept.yml' } as any,
                ],
            });

            expect(result.success).toBe(true);
            // The synced rule is still present in the files → not deleted.
            // None of the path-less rules are deleted either.
            expect(
                mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute,
            ).not.toHaveBeenCalled();
        });
    });
});
