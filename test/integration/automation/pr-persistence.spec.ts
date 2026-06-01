import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RunCodeReviewAutomationUseCase } from '@/ee/automation/runCodeReview.use-case';
import { GithubService } from '@/platform/infrastructure/adapters/services/github/github.service';
import { PlatformIntegrationFactory } from '@/platform/infrastructure/adapters/services/platformIntegration.factory';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { AUTOMATION_SERVICE_TOKEN } from '@/automation/domain/automation/contracts/automation.service';
import { TEAM_AUTOMATION_SERVICE_TOKEN } from '@/automation/domain/teamAutomation/contracts/team-automation.service';
import { EXECUTE_AUTOMATION_SERVICE_TOKEN } from '@/automation/domain/automationExecution/contracts/execute.automation.service.contracts';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PermissionValidationService } from '@/ee/shared/services/permissionValidation.service';
import { AutoAssignLicenseUseCase } from '@/ee/license/use-cases/auto-assign-license.use-case';
import { CacheService } from '@/core/cache/cache.service';
import { INTEGRATION_SERVICE_TOKEN } from '@/integrations/domain/integrations/contracts/integration.service.contracts';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { MCPManagerService } from '@/mcp-server/services/mcp-manager.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { KODY_RULES_ANALYSIS_SERVICE_TOKEN } from '@/ee/codeBase/kodyRulesAnalysis.service';
import { CodeManagementService } from '@/platform/infrastructure/adapters/services/codeManagement.service';
import { WebhookContextService } from '@/platform/application/services/webhook-context.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

describe('PR Persistence Integration Test', () => {
    let useCase: RunCodeReviewAutomationUseCase;

    const mockIntegrationConfigService = {
        findIntegrationConfigWithTeams: jest.fn().mockResolvedValue([
            {
                team: {
                    uuid: 'team-456',
                    organization: { uuid: 'org-123' },
                },
            },
        ]),
        findOne: jest.fn(),
    };
    const mockAutomationService = {
        find: jest.fn().mockResolvedValue([{ uuid: 'auto-uuid' }]),
    };
    const mockTeamAutomationService = {
        find: jest.fn().mockResolvedValue([{ uuid: 'team-auto-uuid' }]),
    };
    const mockOrganizationParametersService = { findByKey: jest.fn() };
    const mockPullRequestsService = {
        find: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    };

    // We mock this initially to simulate the CURRENT behavior (blocking)
    // In Phase 3, we will modify the code so that persistence happens BEFORE this validation check,
    // or inside the flow even if validation fails.
    const mockPermissionValidationService = {
        validateExecutionPermissions: jest.fn().mockResolvedValue({
            allowed: true,
            errorType: null,
            byokConfig: {},
        }),
    };

    const mockAutoAssignLicenseUseCase = { execute: jest.fn() };

    // This is the key service where persistence happens.
    // We will verify that this service is called to "executeStrategy", which implies persistence in the current architecture,
    // OR if we introduce a direct persistence call, we'll spy on that.
    const mockExecuteAutomationService = { executeStrategy: jest.fn() };

    const mockConfigService = {
        get: jest.fn((_key) => 'dummy'),
    };
    const mockCacheService = {
        getFromCache: jest.fn(),
        addToCache: jest.fn(),
        removeFromCache: jest.fn(),
    };
    const mockIntegrationService = {
        findOne: jest.fn().mockResolvedValue({
            uuid: 'int-uuid',
            platform: PlatformType.GITHUB,
            authIntegration: { authDetails: {} },
        }),
        getPlatformAuthDetails: jest.fn().mockResolvedValue({
            authMode: 'token',
            authToken: 'fake-token',
            org: 'owner',
            accountType: 'user',
        }),
    };
    const mockAuthIntegrationService = { update: jest.fn() };
    const mockMCPManagerService = { createKodusMCPIntegration: jest.fn() };
    const mockGithubService = {
        getPullRequest: jest.fn().mockResolvedValue({
            number: 123,
            title: 'Test PR',
            user: { login: 'tester' },
            head: { sha: 'sha123', ref: 'feature' },
            base: { ref: 'main' },
            repository: { id: 1, name: 'repo', owner: { login: 'owner' } },
        }),
        getFilesByPullRequestId: jest.fn().mockResolvedValue([]),
        createReviewComment: jest.fn(),
    };
    const mockLLMAnalysisService = { analyzeCodeWithAI: jest.fn() };
    const mockKodyRulesAnalysisService = { analyzeCodeWithAI: jest.fn() };
    const mockWebhookContextService = { getContext: jest.fn() };

    beforeAll(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RunCodeReviewAutomationUseCase,
                CodeManagementService,
                PlatformIntegrationFactory,
                { provide: GithubService, useValue: mockGithubService },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: AUTOMATION_SERVICE_TOKEN,
                    useValue: mockAutomationService,
                },
                {
                    provide: TEAM_AUTOMATION_SERVICE_TOKEN,
                    useValue: mockTeamAutomationService,
                },
                {
                    provide: EXECUTE_AUTOMATION_SERVICE_TOKEN,
                    useValue: mockExecuteAutomationService,
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: mockOrganizationParametersService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestsService,
                },
                {
                    provide: PermissionValidationService,
                    useValue: mockPermissionValidationService,
                },
                {
                    provide: AutoAssignLicenseUseCase,
                    useValue: mockAutoAssignLicenseUseCase,
                },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: CacheService, useValue: mockCacheService },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: mockIntegrationService,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: mockAuthIntegrationService,
                },
                { provide: MCPManagerService, useValue: mockMCPManagerService },
                {
                    provide: LLM_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockLLMAnalysisService,
                },
                {
                    provide: KODY_RULES_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockKodyRulesAnalysisService,
                },
                {
                    provide: WebhookContextService,
                    useValue: mockWebhookContextService,
                },
            ],
        }).compile();

        useCase = module.get(RunCodeReviewAutomationUseCase);
        const factory = module.get(PlatformIntegrationFactory);
        factory.registerCodeManagementService(
            PlatformType.GITHUB,
            mockGithubService as any,
        );
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should persist execution intent even if business validation fails (Future Behavior)', async () => {
        // Arrange
        const payload = {
            action: 'opened',
            repository: {
                id: 1,
                name: 'repo',
                owner: { login: 'owner' },
                full_name: 'owner/repo',
            },
            issue: { number: 123 },
            sender: { login: 'tester' },
        };

        // Simulate Validation Failure (e.g. no billing)
        // Currently, this would throw or return early.
        // The goal of this task is to ensure we persist BEFORE this check.
        mockPermissionValidationService.validateExecutionPermissions.mockResolvedValueOnce(
            {
                allowed: false,
                errorType: 'BILLING_ERROR',
            },
        );

        // Act
        await useCase.execute({
            codeManagementPayload: payload,
            event: 'pull_request.opened',
            platformType: PlatformType.GITHUB,
            organizationAndTeamData: {} as any,
            teamAutomationId: 'test-automation-id',
        });

        // Assert
        // This expectation will FAIL currently, which is correct for TDD.
        // Once implemented, we expect the execution service to be called to save the initial state,
        // OR the use case itself calls a repository to save.
        // Assuming executeStrategy is responsible for the full flow including saving:
        expect(mockExecuteAutomationService.executeStrategy).toHaveBeenCalled();
    });
});
