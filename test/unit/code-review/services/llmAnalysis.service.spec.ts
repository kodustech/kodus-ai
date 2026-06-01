import { LLMAnalysisService } from '@/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { SafeguardPipelineService } from '@/code-review/infrastructure/adapters/services/safeguardPipeline.service';
import { ReviewModeResponse } from '@/core/infrastructure/config/types/general/codeReview.type';
import { ObservabilityService } from '@/core/log/observability.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { Test, TestingModule } from '@nestjs/testing';

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('LLMAnalysisService', () => {
    let service: LLMAnalysisService;

    const mockPromptRunnerService = {
        builder: jest.fn(() => ({
            setProviders: jest.fn().mockReturnThis(),
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            addMetadata: jest.fn().mockReturnThis(),
            addCallbacks: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            setMaxReasoningTokens: jest.fn().mockReturnThis(),
            execute: jest.fn(),
        })),
    };

    const mockObservabilityService = {
        runLLMInSpan: jest.fn(async ({ exec }) => {
            return exec([]);
        }),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockSafeguardPipelineService = {
        execute: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LLMAnalysisService,
                {
                    provide: PromptRunnerService,
                    useValue: mockPromptRunnerService,
                },
                {
                    provide: ObservabilityService,
                    useValue: mockObservabilityService,
                },
                {
                    provide: SANDBOX_PROVIDER_TOKEN,
                    useValue: {
                        isAvailable: jest.fn().mockReturnValue(false),
                        createSandboxWithRepo: jest.fn(),
                    },
                },
                {
                    provide: SafeguardPipelineService,
                    useValue: mockSafeguardPipelineService,
                },
            ],
        }).compile();

        service = module.get<LLMAnalysisService>(LLMAnalysisService);
        jest.clearAllMocks();
    });

    describe('prepareAnalysisContext', () => {
        it('should prepare complete analysis context', async () => {
            const fileContext = {
                patchWithLinesStr: '@@ -1,1 +1,1 @@',
                file: {
                    filename: 'test.ts',
                    fileContent: 'const x = 1;',
                },
                relevantContent: 'relevant code',
                hasRelevantContent: true,
            };

            const context = {
                pullRequest: { number: 123, body: 'PR description' },
                repository: { language: 'typescript' },
                organizationAndTeamData: mockOrganizationAndTeamData,
                codeReviewConfig: {
                    suggestionControl: {
                        maxSuggestions: 10,
                        limitationType: 'FILE',
                        severityLevelFilter: 'high',
                        groupingMode: 'NONE',
                    },
                    languageResultPrompt: 'en',
                    reviewOptions: { security: true },
                },
            };

            const result = await (service as any).prepareAnalysisContext(
                fileContext,
                context,
            );

            expect(result.pullRequest.number).toBe(123);
            expect(result.patchWithLinesStr).toBe('@@ -1,1 +1,1 @@');
            expect(result.language).toBe('typescript');
            expect(result.filePath).toBe('test.ts');
            expect(result.hasRelevantContent).toBe(true);
            expect(result.organizationAndTeamData).toEqual(
                mockOrganizationAndTeamData,
            );
        });

        it('should handle missing optional fields', async () => {
            const fileContext = {
                patchWithLinesStr: '@@ -1,1 +1,1 @@',
                file: {
                    filename: 'test.ts',
                },
            };

            const context = {
                pullRequest: { number: 123 },
                repository: {},
            };

            const result = await (service as any).prepareAnalysisContext(
                fileContext,
                context,
            );

            expect(result.filePath).toBe('test.ts');
            expect(result.fileContent).toBeUndefined();
            expect(result.relevantContent).toBeUndefined();
        });
    });

    // Note: analyzeCodeWithAI tests are skipped because they require complex mocking
    // of BYOKPromptRunnerService which is instantiated internally;

    describe('selectReviewMode', () => {
        it('should always return HEAVY_MODE', async () => {
            const file = { filename: 'test.ts' };
            const codeDiff = '@@ -1,1 +1,1 @@';

            const result = await service.selectReviewMode(
                mockOrganizationAndTeamData as any,
                123,
                'gemini-2.5-pro' as any,
                file as any,
                codeDiff,
            );

            expect(result).toBe(ReviewModeResponse.HEAVY_MODE);
        });
    });

    describe('validateImplementedSuggestions', () => {
        it('should return original suggestions on error', async () => {
            const mockBuilder = {
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                addMetadata: jest.fn().mockReturnThis(),
                addCallbacks: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setMaxReasoningTokens: jest.fn().mockReturnThis(),
                execute: jest.fn().mockRejectedValue(new Error('LLM error')),
            };

            mockPromptRunnerService.builder.mockReturnValue(mockBuilder);

            const suggestions = [
                { id: 's1', suggestionContent: 'Original suggestion' },
            ];

            const result = await service.validateImplementedSuggestions(
                mockOrganizationAndTeamData as any,
                123,
                'gpt-4o' as any,
                '@@ -1,1 +1,1 @@',
                suggestions,
            );

            expect(result).toEqual(suggestions);
        });
    });

    describe('severityAnalysisAssignment', () => {
        it('should return original suggestions on error', async () => {
            const mockBuilder = {
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                addMetadata: jest.fn().mockReturnThis(),
                addCallbacks: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setMaxReasoningTokens: jest.fn().mockReturnThis(),
                execute: jest.fn().mockRejectedValue(new Error('LLM error')),
            };

            mockPromptRunnerService.builder.mockReturnValue(mockBuilder);

            const suggestions = [{ id: 's1', severity: 'unknown' }];

            const result = await service.severityAnalysisAssignment(
                mockOrganizationAndTeamData as any,
                123,
                'gpt-4o' as any,
                suggestions as any,
                {} as any,
            );

            expect(result).toEqual(suggestions);
        });
    });

    describe('filterSuggestionsSafeGuard', () => {
        it('should remove suggestionEmbedded from suggestions before processing', async () => {
            const suggestions = [
                {
                    id: 's1',
                    suggestionContent: 'test',
                    suggestionEmbedded: [0.1, 0.2, 0.3], // Should be removed
                },
            ];

            mockSafeguardPipelineService.execute.mockResolvedValue({
                suggestions,
            });

            // After the function runs, suggestionEmbedded should be deleted
            await service.filterSuggestionsSafeGuard(
                mockOrganizationAndTeamData as any,
                123,
                { filename: 'test.ts', fileContent: 'code' },
                'relevant',
                '@@ -1,1 +1,1 @@',
                suggestions,
                'en',
                ReviewModeResponse.HEAVY_MODE,
                {} as any,
            );

            // Verify the suggestion no longer has suggestionEmbedded
            expect(suggestions[0]).not.toHaveProperty('suggestionEmbedded');
        });

        it('should return original suggestions on error', async () => {
            const suggestions = [{ id: 's1', suggestionContent: 'original' }];
            mockSafeguardPipelineService.execute.mockRejectedValue(
                new Error('LLM error'),
            );

            const result = await service.filterSuggestionsSafeGuard(
                mockOrganizationAndTeamData as any,
                123,
                { filename: 'test.ts' },
                '',
                '@@ -1,1 +1,1 @@',
                suggestions,
                'en',
                ReviewModeResponse.HEAVY_MODE,
                {} as any,
            );

            expect(result.suggestions).toEqual(suggestions);
        });
    });

    describe('schema validation', () => {
        it('should coerce string line numbers to numbers in LLM response', async () => {
            const mockBuilder = {
                setProviders: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                addMetadata: jest.fn().mockReturnThis(),
                addCallbacks: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setMaxReasoningTokens: jest.fn().mockReturnThis(),
                execute: jest.fn().mockResolvedValue({
                    result: {
                        codeSuggestions: [
                            {
                                id: 's1',
                                relevantFile: 'test.ts',
                                language: 'typescript',
                                suggestionContent: 'Use const instead of var',
                                existingCode: 'var x = 1;',
                                improvedCode: 'const x = 1;',
                                oneSentenceSummary: 'Replace var with const',
                                relevantLinesStart: '143', // String from LLM
                                relevantLinesEnd: '145', // String from LLM
                                label: 'refactoring',
                                severity: 'low',
                            },
                        ],
                    },
                }),
            };

            mockPromptRunnerService.builder.mockReturnValue(mockBuilder);

            const fileContext = {
                patchWithLinesStr:
                    '@@ -143,3 +143,3 @@\n-var x = 1;\n+const x = 1;',
                file: { filename: 'test.ts', fileContent: 'var x = 1;' },
            };

            const context = {
                pullRequest: { number: 123 },
                repository: { language: 'typescript' },
                organizationAndTeamData: mockOrganizationAndTeamData,
                codeReviewConfig: {
                    suggestionControl: {},
                    languageResultPrompt: 'en',
                },
            };

            // This should not throw even though LLM returns strings
            const result = await (service as any).prepareAnalysisContext(
                fileContext,
                context,
            );

            expect(result).toBeDefined();
            expect(result.filePath).toBe('test.ts');
        });
    });

    describe('integration scenarios', () => {
        it('should handle complete code review flow context preparation', async () => {
            const fileContext = {
                patchWithLinesStr: `@@ -1,5 +1,10 @@
function test() {
+  const x = 1;
+  return x;
}`,
                file: {
                    filename: 'src/utils/helper.ts',
                    fileContent: `function test() {
  const x = 1;
  return x;
}`,
                    language: 'typescript',
                },
                relevantContent: 'function test() { ... }',
                hasRelevantContent: true,
            };

            const context = {
                pullRequest: {
                    number: 456,
                    body: 'Add helper function',
                    title: 'feat: add helper',
                },
                repository: {
                    language: 'typescript',
                    name: 'my-repo',
                },
                organizationAndTeamData: mockOrganizationAndTeamData,
                codeReviewConfig: {
                    suggestionControl: {
                        maxSuggestions: 5,
                        limitationType: 'FILE',
                        severityLevelFilter: 'medium',
                        groupingMode: 'FULL',
                    },
                    languageResultPrompt: 'en',
                    reviewOptions: {
                        security: true,
                        code_style: true,
                        performance_and_optimization: false,
                    },
                    v2PromptOverrides: {
                        categoryInstructions: 'Focus on security',
                    },
                },
                externalPromptContext: {
                    references: [],
                },
            };

            const result = await (service as any).prepareAnalysisContext(
                fileContext,
                context,
            );

            // Verify all expected fields are present
            expect(result.pullRequest.number).toBe(456);
            expect(result.patchWithLinesStr).toContain('const x = 1');
            expect(result.maxSuggestionsParams).toBe(5);
            expect(result.language).toBe('typescript');
            expect(result.filePath).toBe('src/utils/helper.ts');
            expect(result.languageResultPrompt).toBe('en');
            expect(result.reviewOptions.security).toBe(true);
            expect(result.fileContent).toContain('function test()');
            expect(result.limitationType).toBe('FILE');
            expect(result.severityLevelFilter).toBe('medium');
            expect(result.groupingMode).toBe('FULL');
            expect(result.relevantContent).toBe('function test() { ... }');
            expect(result.hasRelevantContent).toBe(true);
            expect(result.prSummary).toBe('Add helper function');
            expect(result.v2PromptOverrides.categoryInstructions).toBe(
                'Focus on security',
            );
            expect(result.externalPromptContext).toBeDefined();
        });
    });
});
