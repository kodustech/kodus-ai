import { Test, TestingModule } from '@nestjs/testing';
import { AgentReviewStage } from '@/code-review/pipeline/stages/agent-review.stage';
import { ReviewOrchestratorService } from '@/code-review/infrastructure/agents/review-orchestrator.service';
import { ObservabilityService } from '@/core/log/observability.service';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/automation/domain/automationExecution/contracts/automation-execution.service';
import { GraphContextService } from '@/code-review/infrastructure/adapters/services/graph/graph-context.service';
import { REPOSITORY_SERVICE_TOKEN } from '@/code-review/domain/contracts/RepositoryService.contract';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';
import { CodeReviewVersion } from '@/core/domain/enums/code-review.enum';

jest.mock('ai', () => ({
    generateText: jest.fn().mockResolvedValue({
        object: { classifications: [] },
        output: { classifications: [] },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    Output: { object: jest.fn().mockReturnValue({}) },
    jsonSchema: jest.fn().mockReturnValue({}),
    stepCountIs: () => () => false,
    hasToolCall: () => () => false,
    tool: (opts: any) => opts,
}));

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('AgentReviewStage', () => {
    let stage: AgentReviewStage;
    let mockOrchestrator: jest.Mocked<ReviewOrchestratorService>;

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            dryRun: { enabled: false },
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            } as any,
            repository: {
                id: 'repo-1',
                name: 'test-repo',
                fullName: 'org/test-repo',
            } as any,
            branch: 'main',
            pullRequest: {
                number: 42,
                title: 'Test PR',
                base: { repo: { fullName: 'org/repo' }, ref: 'main' },
                repository: {} as any,
                isDraft: false,
                stats: {
                    total_additions: 10,
                    total_deletions: 5,
                    total_files: 2,
                    total_lines_changed: 15,
                },
            },
            teamAutomationId: 'team-auto-1',
            origin: 'github',
            action: 'opened',
            platformType: PlatformType.GITHUB,
            codeReviewConfig: {
                codeReviewVersion: CodeReviewVersion.V3_AGENT,
                reviewOptions: { bug: true, security: true, performance: true },
            } as any,
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            correlationId: 'test-correlation-id',
            ...overrides,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockOrchestrator = {
            execute: jest.fn().mockResolvedValue({
                suggestions: [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Missing null check',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                    {
                        relevantFile: 'src/api.ts',
                        suggestionContent: 'XSS vulnerability',
                        label: 'security',
                        severity: 'critical',
                        relevantLinesStart: 20,
                        relevantLinesEnd: 25,
                    },
                ],
                agentResults: [
                    {
                        agentName: 'bug-agent',
                        suggestions: [{}],
                        turnsUsed: 3,
                        durationMs: 1000,
                    },
                    {
                        agentName: 'security-agent',
                        suggestions: [{}],
                        turnsUsed: 5,
                        durationMs: 2000,
                    },
                ],
                totalDurationMs: 2500,
            }),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AgentReviewStage,
                {
                    provide: ReviewOrchestratorService,
                    useValue: mockOrchestrator,
                },
                {
                    provide: ObservabilityService,
                    useValue: {
                        runInSpan: jest.fn((_name: string, fn: any) => fn()),
                    },
                },
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: {
                        updateCodeReview: jest.fn(),
                        findLatestStageLog: jest.fn(),
                        updateStageLog: jest.fn(),
                    },
                },
                {
                    provide: GraphContextService,
                    useValue: {
                        generateContext: jest.fn().mockResolvedValue(''),
                        generateContextLegacy: jest.fn().mockResolvedValue(''),
                    },
                },
                {
                    provide: REPOSITORY_SERVICE_TOKEN,
                    useValue: {
                        findOrCreate: jest.fn(),
                        findByExternalId: jest.fn(),
                        updateStatus: jest.fn(),
                    },
                },
            ],
        }).compile();

        stage = module.get<AgentReviewStage>(AgentReviewStage);
    });

    it('should have correct stage name', () => {
        expect(stage.stageName).toBe('AgentReviewStage');
    });

    describe('guard conditions', () => {
        it('should skip when no changed files', async () => {
            const context = createBaseContext({ changedFiles: [] });

            const result = await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).not.toHaveBeenCalled();
            expect(result.fileAnalysisResults).toBeUndefined();
        });

        it('should run self-contained (no tools) when no sandbox handle', async () => {
            // Previously this stage short-circuited when the sandbox was
            // missing. It now falls back to self-contained mode so trial
            // reviews and accounts without a GitHub integration still get
            // a (reduced-context) review instead of being silently skipped.
            const context = createBaseContext({
                changedFiles: [{ filename: 'src/index.ts' } as any],
                sandboxHandle: undefined,
            });

            await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1);
            const call = mockOrchestrator.execute.mock.calls[0][0];
            expect(call.remoteCommands).toBeUndefined();
        });
    });

    describe('execution', () => {
        it('should call orchestrator with correct input', async () => {
            const changedFiles = [
                { filename: 'src/auth.ts', patch: '+code' } as any,
                { filename: 'src/api.ts', patch: '+more code' } as any,
            ];

            const context = createBaseContext({
                changedFiles,
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
                codeReviewConfig: {
                    codeReviewVersion: CodeReviewVersion.V3_AGENT,
                    reviewOptions: {
                        bug: true,
                        security: true,
                        performance: false,
                    },
                    languageResultPrompt: 'pt-BR',
                } as any,
            });

            await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 42,
                    changedFiles,
                    languageResultPrompt: 'pt-BR',
                    reviewOptions: {
                        bug: true,
                        security: true,
                        performance: false,
                    },
                }),
            );
        });

        it('should group suggestions by file into fileAnalysisResults', async () => {
            const changedFiles = [
                { filename: 'src/auth.ts' } as any,
                { filename: 'src/api.ts' } as any,
            ];

            const context = createBaseContext({
                changedFiles,
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.fileAnalysisResults).toHaveLength(2);

            const authResult = result.fileAnalysisResults.find(
                (r: any) => r.file.filename === 'src/auth.ts',
            );
            expect(authResult.validSuggestionsToAnalyze).toHaveLength(1);
            expect(authResult.validSuggestionsToAnalyze[0].label).toBe('bug');

            const apiResult = result.fileAnalysisResults.find(
                (r: any) => r.file.filename === 'src/api.ts',
            );
            expect(apiResult.validSuggestionsToAnalyze).toHaveLength(1);
            expect(apiResult.validSuggestionsToAnalyze[0].label).toBe(
                'security',
            );
        });

        it('should set empty discardedSuggestions for each file', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'src/auth.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
            });

            const result = await (stage as any).executeStage(context);

            for (const fileResult of result.fileAnalysisResults) {
                expect(fileResult.discardedSuggestionsBySafeGuard).toEqual([]);
            }
        });
    });

    describe('kody rules severity', () => {
        it('should use severity from the Kody Rule, not from the LLM or classifier', async () => {
            // Orchestrator returns a finding with ruleUuid and a LOW severity
            // (whatever the LLM decided). The stage should override it with
            // the severity from the matched Kody Rule (HIGH).
            mockOrchestrator.execute.mockResolvedValue({
                suggestions: [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Violates rule: must use strict null checks',
                        label: 'kody_rules',
                        severity: 'low', // LLM's opinion — should be ignored
                        brokenKodyRulesIds: ['rule-uuid-123'],
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ],
                agentResults: [
                    {
                        agentName: 'kody-rules-agent',
                        suggestions: [{}],
                        turnsUsed: 3,
                        durationMs: 1000,
                    },
                ],
                totalDurationMs: 1000,
            });

            const context = createBaseContext({
                changedFiles: [{ filename: 'src/auth.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
                codeReviewConfig: {
                    codeReviewVersion: CodeReviewVersion.V3_AGENT,
                    reviewOptions: { bug: true, security: true, performance: true },
                    kodyRules: [
                        {
                            uuid: 'rule-uuid-123',
                            title: 'Strict null checks',
                            severityLevel: 'high',
                            severity: 'high',
                            status: 'active',
                            type: 'standard',
                        },
                    ],
                } as any,
            });

            const result = await (stage as any).executeStage(context);

            const suggestion =
                result.fileAnalysisResults[0].validSuggestionsToAnalyze[0];
            expect(suggestion.severity).toBe('high');
            expect(suggestion.brokenKodyRulesIds).toEqual(['rule-uuid-123']);
        });
    });

    describe('error handling', () => {
        it('should return empty results on orchestrator failure', async () => {
            mockOrchestrator.execute.mockRejectedValue(
                new Error('Agent loop crashed'),
            );

            const context = createBaseContext({
                changedFiles: [{ filename: 'src/index.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.fileAnalysisResults).toEqual([]);
        });

        it('should handle undefined agentResults without throwing', async () => {
            mockOrchestrator.execute.mockResolvedValue({
                suggestions: [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Missing null check',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ],
                agentResults: undefined,
                totalDurationMs: 1000,
            });

            const context = createBaseContext({
                changedFiles: [{ filename: 'src/auth.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.fileAnalysisResults).toHaveLength(1);
            expect(result.fileAnalysisResults[0].validSuggestionsToAnalyze).toHaveLength(1);
        });

    });
});
