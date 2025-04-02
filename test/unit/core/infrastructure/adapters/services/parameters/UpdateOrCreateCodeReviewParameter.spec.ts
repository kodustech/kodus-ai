import {
    BehaviourForExistingDescription,
    CodeReviewConfigWithoutLLMProvider,
    LimitationType,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/update-or-create-code-review-parameter-use-case';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { IntegrationConfigService } from '@/core/infrastructure/adapters/services/integrations/integrationConfig.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ParametersService } from '@/core/infrastructure/adapters/services/parameters.service';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { Test, TestingModule } from '@nestjs/testing';

describe('UpdateOrCreateCodeReviewParameterUseCase', () => {
    let useCase: UpdateOrCreateCodeReviewParameterUseCase;

    let parametersService: ParametersService;

    let integrationConfigService: IntegrationConfigService;

    let logger: PinoLoggerService;

    const mockParametersService = {
        findByKey: jest.fn(),
        createOrUpdateConfig: jest.fn(),
    };

    const mockIntegrationConfigService = {
        findIntegrationConfigFormatted: jest.fn(),
    };

    const mockLogger = {
        error: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UpdateOrCreateCodeReviewParameterUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                { provide: PinoLoggerService, useValue: mockLogger },
            ],
        }).compile();

        useCase = module.get<UpdateOrCreateCodeReviewParameterUseCase>(
            UpdateOrCreateCodeReviewParameterUseCase,
        );
        parametersService = module.get<ParametersService>(
            PARAMETERS_SERVICE_TOKEN,
        );
        integrationConfigService = module.get<IntegrationConfigService>(
            INTEGRATION_CONFIG_SERVICE_TOKEN,
        );
        logger = module.get<PinoLoggerService>(PinoLoggerService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const MOCK_TEAM_ID = 'team_id1';

    const MOCK_CONFIG_VALUE: Omit<
        CodeReviewConfigWithoutLLMProvider,
        'summary'
    > = {
        ignorePaths: [],
        baseBranches: [],
        reviewOptions: {
            security: false,
            code_style: true,
            refactoring: true,
            error_handling: false,
            maintainability: false,
            potential_issues: true,
            documentation_and_comments: true,
            performance_and_optimization: true,
            kody_rules: true,
        },
        maxSuggestions: 20,
        ignoredTitleKeywords: [],
        automatedReviewActive: true,
        limitationType: LimitationType.PR,
        severityLevelFilter: SeverityLevel.MEDIUM,
        kodyRules: [],
    };

    const MOCK_OLD_CONFIG_VALUE: Omit<
        CodeReviewConfigWithoutLLMProvider,
        'summary'
    > = {
        ignorePaths: [],
        baseBranches: [],
        reviewOptions: {
            security: true,
            code_style: true,
            refactoring: true,
            error_handling: false,
            maintainability: false,
            potential_issues: true,
            documentation_and_comments: false,
            performance_and_optimization: true,
            kody_rules: true,
        },
        maxSuggestions: 20,
        ignoredTitleKeywords: [],
        automatedReviewActive: true,
        limitationType: LimitationType.PR,
        severityLevelFilter: SeverityLevel.MEDIUM,
        kodyRules: [],
    };

    it('should create a new configuration when none exists', async () => {
        const body = {
            organizationAndTeamData: {
                teamId: MOCK_TEAM_ID,
            } as OrganizationAndTeamData,
            configValue: MOCK_OLD_CONFIG_VALUE,
        };

        mockParametersService.findByKey.mockResolvedValue(null);
        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [],
        );

        const mockParametersEntity = new ParametersEntity({
            uuid: 'uuid',
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: MOCK_CONFIG_VALUE,
        });

        mockParametersService.createOrUpdateConfig.mockResolvedValue(
            mockParametersEntity,
        );

        const result = await useCase.execute(body);

        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            expect.objectContaining({
                global: {
                    ...body.configValue,
                    summary: {
                        generatePRSummary: true,
                        customInstructions: '',
                        behaviourForExistingDescription:
                            BehaviourForExistingDescription.REPLACE,
                    },
                },
                repositories: [],
            }),
            body.organizationAndTeamData,
        );
        expect(result).toBeInstanceOf(ParametersEntity);
    });

    it('should update existing global configuration when it exists', async () => {
        const body = {
            organizationAndTeamData: {
                teamId: MOCK_TEAM_ID,
            } as OrganizationAndTeamData,
            configValue: MOCK_CONFIG_VALUE,
        };

        const existingConfig = {
            configValue: {
                global: MOCK_OLD_CONFIG_VALUE,
                repositories: [],
            },
        };

        mockParametersService.findByKey.mockResolvedValue(existingConfig);
        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [],
        );

        const updatedParametersEntity = new ParametersEntity({
            uuid: 'uuid',
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: {
                global: {
                    ...existingConfig.configValue.global,
                    ...body.configValue,
                },
                repositories: [],
            },
        });

        mockParametersService.createOrUpdateConfig.mockResolvedValue(
            updatedParametersEntity,
        );

        const result = await useCase.execute(body);

        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            expect.objectContaining({
                global: {
                    ...existingConfig.configValue.global,
                    ...body.configValue,
                },
                repositories: [],
            }),
            body.organizationAndTeamData,
        );
        expect(result).toEqual(updatedParametersEntity);
    });

    it('should update specific repository configuration when repositoryId is provided', async () => {
        const body = {
            organizationAndTeamData: {
                teamId: MOCK_TEAM_ID,
            } as OrganizationAndTeamData,
            configValue: MOCK_CONFIG_VALUE,
            repositoryId: 'repo-123',
        };

        const existingConfig = {
            configValue: {
                global: MOCK_OLD_CONFIG_VALUE,
                repositories: [
                    {
                        id: 'repo-123',
                        name: 'Repo 123',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                    {
                        id: 'repo-456',
                        name: 'Repo 456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                ],
            },
        };

        mockParametersService.findByKey.mockResolvedValue(existingConfig);
        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [],
        );

        const updatedParametersEntity = new ParametersEntity({
            uuid: 'uuid',
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: {
                global: existingConfig.configValue.global,
                repositories: [
                    { id: 'repo-123', name: 'Repo 123', ...MOCK_CONFIG_VALUE },
                    {
                        id: 'repo-456',
                        name: 'Repo 456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                ],
            },
        });

        mockParametersService.createOrUpdateConfig.mockResolvedValue(
            updatedParametersEntity,
        );

        const result = await useCase.execute(body);

        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            expect.objectContaining({
                global: existingConfig.configValue.global,
                repositories: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'repo-123',
                        ...MOCK_CONFIG_VALUE,
                    }),
                    expect.objectContaining({
                        id: 'repo-456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    }),
                ]),
            }),
            body.organizationAndTeamData,
        );
        expect(result).toEqual(updatedParametersEntity);
    });

    const MOCK_PARTIAL_CONFIG_VALUE = {
    };

    it('should be able to update existing global configuration object partially, without overwriting everything', async () => {
        const body = {
            organizationAndTeamData: {
                teamId: MOCK_TEAM_ID,
            } as OrganizationAndTeamData,
            configValue: MOCK_PARTIAL_CONFIG_VALUE,
        };

        const existingConfig = {
            configValue: {
                global: MOCK_CONFIG_VALUE,
                repositories: [],
            },
        };

        mockParametersService.findByKey.mockResolvedValue(existingConfig);

        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [],
        );

        const updatedParametersEntity = new ParametersEntity({
            uuid: 'uuid',
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: {
                global: {
                    ...existingConfig.configValue.global,
                    ...body.configValue,
                },
                repositories: [],
            },
        });

        mockParametersService.createOrUpdateConfig.mockResolvedValue(
            updatedParametersEntity,
        );

        const result = await useCase.execute(body);

        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            expect.objectContaining({
                global: {
                    ...existingConfig.configValue.global,
                    ...body.configValue,
                },
                repositories: [],
            }),
            body.organizationAndTeamData,
        );
        expect(result).toEqual(updatedParametersEntity);
    });

    it('should be able to update existing repository configuration object partially, without overwriting everything', async () => {
        const body = {
            organizationAndTeamData: {
                teamId: MOCK_TEAM_ID,
            } as OrganizationAndTeamData,
            configValue: MOCK_PARTIAL_CONFIG_VALUE,
            repositoryId: 'repo-123',
        };

        const existingConfig = {
            configValue: {
                global: MOCK_OLD_CONFIG_VALUE,
                repositories: [
                    {
                        id: 'repo-123',
                        name: 'Repo 123',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                    {
                        id: 'repo-456',
                        name: 'Repo 456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                ],
            },
        };

        // Mocking the service responses
        mockParametersService.findByKey.mockResolvedValue(existingConfig);
        mockIntegrationConfigService.findIntegrationConfigFormatted.mockResolvedValue(
            [
                {
                    id: 'repo-123',
                    name: 'Repo 123',
                    default_branch: 'main',
                    http_url: 'http://example.com/repo-123',
                    language: 'JavaScript',
                    organizationName: 'Org',
                    selected: 'true',
                    visibility: 'public',
                },
                {
                    id: 'repo-456',
                    name: 'Repo 456',
                    default_branch: 'main',
                    http_url: 'http://example.com/repo-456',
                    language: 'JavaScript',
                    organizationName: 'Org',
                    selected: 'true',
                    visibility: 'public',
                },
            ],
        );

        // The updated repository configuration should merge the old config with the new partial config
        const updatedRepoConfigs = {
            ...MOCK_OLD_CONFIG_VALUE, // Retain the old values
            ...MOCK_PARTIAL_CONFIG_VALUE, // Apply the new style guide
        };

        const updatedParametersEntity = new ParametersEntity({
            uuid: 'uuid',
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: {
                global: {
                    ...existingConfig.configValue.global,
                    // Ensure the global config retains the old values and merges correctly
                },
                repositories: [
                    { id: 'repo-123', name: 'Repo 123', ...updatedRepoConfigs },
                    {
                        id: 'repo-456',
                        name: 'Repo 456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    },
                ],
            },
        });

        // Mock the createOrUpdateConfig method to return the updated parameters entity
        mockParametersService.createOrUpdateConfig.mockResolvedValue(
            updatedParametersEntity,
        );

        // Execute the use case
        const result = await useCase.execute(body);

        // Assertions to verify the expected behavior
        expect(parametersService.createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            expect.objectContaining({
                global: expect.objectContaining({
                    ...existingConfig.configValue.global, // Ensure global config is retained
                }),
                repositories: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'repo-123',
                        name: 'Repo 123',
                        ...updatedRepoConfigs,
                    }), // Updated repo
                    expect.objectContaining({
                        id: 'repo-456',
                        name: 'Repo 456',
                        ...MOCK_OLD_CONFIG_VALUE,
                    }), // Unchanged repo
                ]),
            }),
            body.organizationAndTeamData,
        );

        // Check that the result matches the expected updated parameters entity
        expect(result).toEqual(updatedParametersEntity);
    });
});
