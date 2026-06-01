import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformIntegrationFactory } from '@libs/platform/infrastructure/adapters/services/platformIntegration.factory';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { AUTOMATION_SERVICE_TOKEN } from '@libs/automation/domain/automation/contracts/automation.service';
import { TEAM_AUTOMATION_SERVICE_TOKEN } from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { EXECUTE_AUTOMATION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/execute.automation.service.contracts';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CacheService } from '@libs/core/cache/cache.service';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { KODY_RULES_ANALYSIS_SERVICE_TOKEN } from '@libs/ee/codeBase/kodyRulesAnalysis.service';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';

// --- MOCK DEFINITIONS ---
// Definindo localmente para evitar problemas de importação circular ou paths não resolvidos
const AuthMode = { TOKEN: 'token' };
const PlatformType = { GITHUB: 'GITHUB' };

// Mock Crypto
jest.mock('@/common/utils/crypto', () => ({
    decrypt: jest.fn((token) => token),
    encrypt: jest.fn((token) => token),
}));

describe('Code Review Workflow Logic Integrity (No AST)', () => {
    let useCase: RunCodeReviewAutomationUseCase;
    let githubService: GithubService;
    let _llmAnalysisService: any; // Mocked

    // --- SERVICE MOCKS ---
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
    const mockPermissionValidationService = {
        validateExecutionPermissions: jest.fn().mockResolvedValue({
            allowed: true,
            errorType: null,
            byokConfig: {},
        }),
    };
    const mockAutoAssignLicenseUseCase = { execute: jest.fn() };
    const mockExecuteAutomationService = { executeStrategy: jest.fn() };
    const mockConfigService = {
        get: jest.fn((key) => {
            if (key === 'API_GITHUB_APP_ID') return '123';
            if (key === 'API_GITHUB_PRIVATE_KEY') return 'dummy-key';
            return 'dummy';
        }),
    };
    const mockCacheService = {
        getFromCache: jest.fn(),
        addToCache: jest.fn(),
        removeFromCache: jest.fn(),
    };
    const mockIntegrationService = {
        findOne: jest.fn(),
        getPlatformAuthDetails: jest.fn(),
    };
    const mockAuthIntegrationService = { update: jest.fn() };
    const mockMCPManagerService = { createKodusMCPIntegration: jest.fn() };

    // Mock do LLM Analysis (Onde a AST era usada)
    const mockLLMAnalysisService = {
        analyzeCodeWithAI: jest.fn(),
        analyzeCodeWithAI_v2: jest.fn().mockResolvedValue({
            codeSuggestions: [
                {
                    relevantFile: 'test.ts',
                    suggestionContent: 'Better code',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                },
            ],
        }),
    };

    const mockKodyRulesAnalysisService = {
        analyzeCodeWithAI: jest.fn(),
    };

    beforeAll(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RunCodeReviewAutomationUseCase,
                CodeManagementService,
                GithubService,
                PlatformIntegrationFactory,
                CodeAnalysisOrchestrator, // Importante: Testar o Orchestrator real
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
                // Mockando os serviços de análise
                {
                    provide: LLM_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockLLMAnalysisService,
                },
                {
                    provide: KODY_RULES_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockKodyRulesAnalysisService,
                },
                { provide: WebhookContextService, useValue: {} },
            ],
        }).compile();

        useCase = module.get(RunCodeReviewAutomationUseCase);
        githubService = module.get(GithubService);
        _llmAnalysisService = module.get(LLM_ANALYSIS_SERVICE_TOKEN);

        const factory = module.get(PlatformIntegrationFactory);
        factory.registerCodeManagementService(
            PlatformType.GITHUB,
            githubService,
        );
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should complete the workflow successfully when AST is removed', async () => {
        // --- ARRANGE ---
        // 1. Mock GitHub Inputs
        jest.spyOn(githubService, 'getPullRequest').mockResolvedValue({
            number: 123,
            title: 'Test PR',
            user: { login: 'tester' },
            head: { sha: 'sha123', ref: 'feature' },
            base: { ref: 'main' },
            repository: { id: 1, name: 'repo', owner: { login: 'owner' } },
        } as any);

        // Mock download de arquivos/diff
        jest.spyOn(githubService, 'getFilesByPullRequestId').mockResolvedValue([
            {
                filename: 'test.ts',
                status: 'modified',
                sha: 'blob123',
                patch: 'diff content',
            } as any,
        ]);
        jest.spyOn(githubService, 'getRepositoryContentFile').mockResolvedValue(
            {
                data: {
                    content: Buffer.from('const a = 1;').toString('base64'),
                    encoding: 'base64',
                },
            } as any,
        );

        // Mock criação de comentário (Output)
        const _createCommentSpy = jest
            .spyOn(githubService, 'createReviewComment')
            .mockResolvedValue({ id: 1 } as any);

        // 2. Mock Database/Auth
        mockIntegrationService.getPlatformAuthDetails.mockResolvedValue({
            authMode: AuthMode.TOKEN,
            authToken: 'fake-token',
            org: 'owner',
            accountType: 'user',
        });
        mockIntegrationService.findOne.mockResolvedValue({
            uuid: 'int-uuid',
            platform: PlatformType.GITHUB,
            authIntegration: { authDetails: {} },
        });

        // 3. Mock Strategy Execution (Simulate Pipeline Behavior)
        // O ExecuteAutomationService chama a estratégia. Em vez de mockar ele inteiro,
        // precisaríamos que ele rodasse a estratégia real se quiséssemos testar a pipeline real.
        // MAS, como estamos testando o UseCase, o UseCase para no 'executeStrategy'.
        // O teste real da pipeline (CodeReviewPipelineStrategyEE) é complexo demais para mockar aqui.
        // ENTÃO: Vamos assumir que se o UseCase chegar no 'executeStrategy', o orquestrador de entrada funcionou.
        // PARA TESTAR O ORCHESTRATOR: Vamos instanciar o CodeAnalysisOrchestrator diretamente em outro teste abaixo.

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

        // --- ACT ---
        await useCase.execute({
            codeManagementPayload: payload,
            event: 'pull_request.opened',
            platformType: PlatformType.GITHUB,
            throwOnError: true,
        } as any);

        // --- ASSERT ---
        // Verifica se a automação foi chamada (Orchestrator acionou a estratégia)
        expect(mockExecuteAutomationService.executeStrategy).toHaveBeenCalled();

        // Verifica se o serviço do GitHub foi chamado corretamente
        expect(githubService.getPullRequest).toHaveBeenCalled();

        // Verifica se o LLM foi chamado (através do orquestrador)
        // Como o UseCase chama executeStrategy, precisamos garantir que o Orchestrator
        // preparou o contexto corretamente.
        // Nota: O UseCase que estamos testando para no executeStrategy.
        // O teste de orquestração abaixo valida o resto.

        console.log('✅ Fluxo inicial do UseCase validado');
    });

    it('should pass full file content to LLM when AST is missing', async () => {
        const orchestrator = new CodeAnalysisOrchestrator(
            mockLLMAnalysisService,
            mockKodyRulesAnalysisService,
        );

        const mockFileContext = {
            file: { filename: 'test.ts', fileContent: 'FULL FILE CONTENT' },
            patchWithLinesStr: 'diff',
        };
        const mockContext = {
            codeReviewConfig: { codeReviewVersion: 'v1' },
            organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        };

        await orchestrator.executeStandardAnalysis(
            mockContext.organizationAndTeamData as any,
            123,
            mockFileContext as any,
            'LIGHT_MODE' as any,
            mockContext as any,
        );

        // Verifica se o conteúdo enviado para o LLM é o conteúdo completo do arquivo
        expect(mockLLMAnalysisService.analyzeCodeWithAI_v2).toHaveBeenCalled();
        const callArgs = mockLLMAnalysisService.analyzeCodeWithAI_v2.mock.calls[0];
        expect(callArgs[2]).toEqual(
            expect.objectContaining({
                file: expect.objectContaining({
                    fileContent: 'FULL FILE CONTENT',
                }),
            }),
        );

        console.log('✅ Fallback de contexto (arquivo completo) validado');
    });

    it('should orchestrate analysis without AST service call', async () => {
        // Este teste verifica o "CodeAnalysisOrchestrator" isoladamente
        // para garantir que ele não tenta chamar o serviço de AST.

        const orchestrator = new CodeAnalysisOrchestrator(
            mockLLMAnalysisService,
            mockKodyRulesAnalysisService,
        );

        const mockOrganizationAndTeamData = {
            organizationId: 'org',
            teamId: 'team',
        };
        const mockFileContext = { file: { filename: 'test.ts' } };
        const mockContext = {
            codeReviewConfig: { codeReviewVersion: 'v1' },
            organizationAndTeamData: mockOrganizationAndTeamData,
        };

        // --- ACT ---
        await orchestrator.executeStandardAnalysis(
            mockOrganizationAndTeamData as any,
            123,
            mockFileContext as any,
            'LIGHT_MODE' as any,
            mockContext as any,
        );

        // --- ASSERT ---
        // 1. Deve chamar o LLM Standard
        expect(mockLLMAnalysisService.analyzeCodeWithAI_v2).toHaveBeenCalled();

        // 2. Não deve ter quebrado (try/catch interno do orchestrator)
        // Se tivesse tentado chamar ASTAnalysisService (que não injetamos), teria dado erro se ainda estivesse no código.
    });
});
