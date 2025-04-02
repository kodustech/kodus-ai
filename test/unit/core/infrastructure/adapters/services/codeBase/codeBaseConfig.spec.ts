import {
    BehaviourForExistingDescription,
    CodeReviewConfig,
    LimitationType,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { KODY_RULES_SERVICE_TOKEN } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { KodyRulesEntity } from '@/core/domain/kodyRules/entities/kodyRules.entity';
import { PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import CodeBaseConfigService from '@/core/infrastructure/adapters/services/codeBase/codeBaseConfig.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { INTEGRATION_SERVICE_TOKEN } from '@/core/domain/integrations/contracts/integration.service.contracts';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { Test, TestingModule } from '@nestjs/testing';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import * as globalPathsJsonFile from '@/shared/utils/codeBase/ignorePaths/generated/paths.json';

// Mock the function decorator
jest.mock(
    '@/shared/utils/decorators/validate-code-management-integration.decorator',
    () => ({ ValidateCodeManagementIntegration: () => jest.fn() }),
);

describe('codeBaseConfig', () => {
    const globalFilePaths = globalPathsJsonFile.paths;

    let codeBaseConfigService: CodeBaseConfigService;

    const mockParametersService = {
        findOne: jest.fn(),
        findByKey: jest.fn(),
    };

    const mockIntegrationService = {};

    const mockIntegrationConfigService = {};

    const mockKodyRulesService = {
        findByOrganizationId: jest.fn(),
    };

    const mockCodeManagmentService = {
        getDefaultBranch: jest.fn(),
    };

    const mockLogger = {};

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CodeBaseConfigService,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: mockIntegrationService,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: mockKodyRulesService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagmentService,
                },
                {
                    provide: PinoLoggerService,
                    useValue: mockLogger,
                },
            ],
        }).compile();

        codeBaseConfigService = module.get<CodeBaseConfigService>(
            CodeBaseConfigService,
        );
    });

    it('should be defined', () => {
        expect(codeBaseConfigService).toBeDefined();
    });

    const MOCK_ORGANIZATION_AND_TEAM_DATA: OrganizationAndTeamData = {
        organizationId: 'organizationId',
        teamId: 'teamId',
    };

    const MOCK_REPOSITORY_DATA = {
        name: 'repositoryName',
        id: 'repositoryId',
    };

    const MOCK_CODE_REVIEW_CONFIG: {
        global: CodeReviewConfig;
        repositories: CodeReviewConfig[];
    } = {
        global: {
            automatedReviewActive: true,
            baseBranches: ['master'],
            ignoredTitleKeywords: ['WIP'],
            ignorePaths: [
                'we/ignore/this/path/*',
                'we/ignore/this/other/path/*',
            ],
            languageResultPrompt: 'en-US',
            reviewOptions: {
                code_style: true,
                documentation_and_comments: true,
                error_handling: true,
                kody_rules: true,
                maintainability: true,
                performance_and_optimization: true,
                potential_issues: true,
                refactoring: true,
                security: true,
            },
            summary: {
                behaviourForExistingDescription:
                    BehaviourForExistingDescription.REPLACE,
                customInstructions: 'custom instructions',
                generatePRSummary: true,
            },
            kodyRules: [],
            pullRequestApprovalActive: false,
            kodusConfigFileOverridesWebPreferences: false,
        },
        repositories: [],
    };

    const MOCK_CODE_REVIEW_CONFIG_ENTITY = new ParametersEntity({
        configKey: ParametersKey.CODE_REVIEW_CONFIG,
        configValue: MOCK_CODE_REVIEW_CONFIG,
    });

    const MOCK_LANGUAGE_CONFIG_ENTITY = new ParametersEntity({
        configKey: ParametersKey.LANGUAGE_CONFIG,
        configValue: MOCK_CODE_REVIEW_CONFIG.global.languageResultPrompt,
    });

    const MOCK_KODY_RULES_ENTITY = new KodyRulesEntity({
        organizationId: MOCK_ORGANIZATION_AND_TEAM_DATA.organizationId,
        rules: [],
    });

    it('should return correct code review config', async () => {
        mockParametersService.findOne.mockResolvedValueOnce(
            MOCK_CODE_REVIEW_CONFIG_ENTITY,
        );
        mockParametersService.findByKey.mockResolvedValueOnce(
            MOCK_LANGUAGE_CONFIG_ENTITY,
        );
        mockCodeManagmentService.getDefaultBranch.mockResolvedValueOnce(
            MOCK_CODE_REVIEW_CONFIG.global.baseBranches[0],
        );
        mockKodyRulesService.findByOrganizationId.mockResolvedValueOnce(
            MOCK_KODY_RULES_ENTITY,
        );

        const codeReviewConfig = await codeBaseConfigService.getConfig(
            MOCK_ORGANIZATION_AND_TEAM_DATA,
            MOCK_REPOSITORY_DATA,
        );

        MOCK_CODE_REVIEW_CONFIG.global.ignorePaths = globalFilePaths
            .concat(MOCK_CODE_REVIEW_CONFIG.global.ignorePaths)
            .sort();

        codeReviewConfig.ignorePaths = codeReviewConfig.ignorePaths.sort();

        expect(codeReviewConfig).toEqual(MOCK_CODE_REVIEW_CONFIG.global);
    });
});
