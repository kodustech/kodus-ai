import { createLogger } from '@kodus/flow';
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
            const configFiles: IConfigFileMeta[] = [];

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
            expect(
                mockCreateOrUpdateParametersUseCase.execute,
            ).not.toHaveBeenCalled();
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
            expect(
                mockCreateOrUpdateKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    uuid: 'pending-rule-uuid',
                    centralizedConfig: {
                        path: '.kody-rules/review/security.yml',
                        status: 'synced',
                    },
                    status: 'active',
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

            expect(result.success).toBe(true);
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
                ruleFiles: [],
            });

            expect(result.success).toBe(true);
            expect(
                mockDeleteRuleInOrganizationByIdKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith('pending-merge-rule-1', actor);
        });
    });
});
