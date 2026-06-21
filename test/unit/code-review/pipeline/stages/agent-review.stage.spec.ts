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

const mockTracedGenerateText = jest.fn();
const mockWithStructuredOutputFallback = jest.fn();

jest.mock(
    '@libs/code-review/infrastructure/agents/llm/agent-loop',
    () => ({
        tracedGenerateText: (...args: any[]) => mockTracedGenerateText(...args),
    }),
);

jest.mock(
    '@libs/code-review/infrastructure/agents/llm/byok-to-vercel',
    () => ({
        withStructuredOutputFallback: (...args: any[]) =>
            mockWithStructuredOutputFallback(...args),
        NoStructuredFallbackModelError: class extends Error {},
        getModelName: jest.fn().mockReturnValue('test-model'),
    }),
);

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
                failures: [],
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

    describe('writeAgentTrace - race condition (Bug 2)', () => {
        let mockAutomationService: any;

        beforeEach(() => {
            mockAutomationService = (stage as any).automationExecutionService;
            mockAutomationService.updateCodeReview.mockReset();
            mockAutomationService.findLatestStageLog.mockReset();
            mockAutomationService.updateStageLog.mockReset();
        });

        const makeEvent = (status: string, overrides: any = {}) => ({
            agentName: 'generalist-review-agent',
            agentCategory: 'generalist',
            status,
            ...overrides,
        });

        it('started event should call updateCodeReview (create)', async () => {
            mockAutomationService.updateCodeReview.mockResolvedValue({
                execution: { uuid: 'exec-1' },
                stageLog: { uuid: 'log-1' },
            });

            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('started'),
                'Agent — investigating...',
                new Map(),
            );

            expect(
                mockAutomationService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockAutomationService.findLatestStageLog,
            ).not.toHaveBeenCalled();
        });

        it('non-started event with existing record should update via updateStageLog', async () => {
            mockAutomationService.findLatestStageLog.mockResolvedValue({
                uuid: 'existing-log-1',
                metadata: {},
            });

            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('batch_started', {
                    batchIndex: 1,
                    batchTotal: 2,
                    batchFiles: 3,
                }),
                'Agent batch 1/2 — starting (3 files)',
                new Map(),
            );

            expect(
                mockAutomationService.findLatestStageLog,
            ).toHaveBeenCalledWith('exec-1', 'AgentReview::generalist');
            expect(
                mockAutomationService.updateStageLog,
            ).toHaveBeenCalledWith(
                'existing-log-1',
                expect.objectContaining({ status: 'in_progress' }),
            );
            expect(
                mockAutomationService.updateCodeReview,
            ).not.toHaveBeenCalled();
        });

        it('non-started event with NO existing record should skip fallback (fix)', async () => {
            mockAutomationService.findLatestStageLog.mockResolvedValue(null);

            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('batch_started', {
                    batchIndex: 1,
                    batchTotal: 2,
                    batchFiles: 3,
                }),
                'Agent batch 1/2 — starting (3 files)',
                new Map(),
            );

            // After fix: no fallback creation — prevents orphaned records
            expect(
                mockAutomationService.updateCodeReview,
            ).not.toHaveBeenCalled();
            expect(
                mockAutomationService.updateStageLog,
            ).not.toHaveBeenCalled();
        });

        it('race condition: batch_started then started creates only one record', async () => {
            mockAutomationService.findLatestStageLog.mockResolvedValue(null);
            mockAutomationService.updateCodeReview.mockResolvedValue({
                execution: { uuid: 'exec-1' },
                stageLog: { uuid: 'log-1' },
            });

            const toolCalls = new Map();

            // batch_started fires first — findLatestStageLog returns null,
            // but after fix it skips fallback (no orphaned record)
            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('batch_started', {
                    batchIndex: 1,
                    batchTotal: 2,
                    batchFiles: 3,
                }),
                'Agent batch 1/2 — starting (3 files)',
                toolCalls,
            );

            // started fires second — creates the record via updateCodeReview
            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('started'),
                'Agent — investigating...',
                toolCalls,
            );

            // After fix: only 1 record created (by started), no orphan
            expect(
                mockAutomationService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockAutomationService.updateCodeReview.mock.calls[0][1].status,
            ).toBe('in_progress');
        });

        it('terminal event (completed) with NO existing record should still create via fallback', async () => {
            mockAutomationService.findLatestStageLog.mockResolvedValue(null);
            mockAutomationService.updateCodeReview.mockResolvedValue({
                execution: { uuid: 'exec-1' },
                stageLog: { uuid: 'log-1' },
            });

            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('completed', { findings: 5, durationMs: 3000 }),
                'Agent — 5 findings 3.0s',
                new Map(),
            );

            // Terminal events must create a record even when no existing log found
            expect(
                mockAutomationService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockAutomationService.updateCodeReview.mock.calls[0][1].status,
            ).toBe('success');
        });

        it('terminal event (error) with NO existing record should still create via fallback', async () => {
            mockAutomationService.findLatestStageLog.mockResolvedValue(null);
            mockAutomationService.updateCodeReview.mockResolvedValue({
                execution: { uuid: 'exec-1' },
                stageLog: { uuid: 'log-1' },
            });

            await (stage as any).writeAgentTrace(
                'exec-1',
                42,
                'repo-1',
                'AgentReview::generalist',
                makeEvent('error', {
                    errorMessage: 'timeout',
                    finishReason: 'timeout',
                }),
                'Agent — failed 5.0s (timeout)',
                new Map(),
            );

            expect(
                mockAutomationService.updateCodeReview,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockAutomationService.updateCodeReview.mock.calls[0][1].status,
            ).toBe('error');
        });
    });

    describe('deduplicateSuggestions - NaN index handling (three-layer protection)', () => {
        const makeSuggestions = (count: number) =>
            Array.from({ length: count }, (_, i) => ({
                relevantFile: `src/file-${i}.ts`,
                suggestionContent: `Suggestion ${i}`,
                label: 'bug',
                severity: 'high',
                relevantLinesStart: i * 10,
                relevantLinesEnd: i * 10 + 5,
                oneSentenceSummary: `Summary ${i}`,
            }));

        beforeEach(() => {
            mockTracedGenerateText.mockReset();
            mockWithStructuredOutputFallback.mockReset();
        });

        it('Layer 1: should reject NaN keep index', async () => {
            const suggestions = makeSuggestions(4);

            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: NaN, duplicates: [1, 2] }],
                    unique: [0],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // Layer 1: NaN keep rejected → Layer 2: valid dups (1, 2) preserved
                // Layer 3: unclassified suggestion 3 also preserved
                // unique[0] + dup 1 + dup 2 + unclassified 3 = 4
                expect(result.suggestions).toHaveLength(4);
                for (const s of result.suggestions) {
                    expect(s.relevantFile).toBeDefined();
                    expect(s.suggestionContent).not.toContain('undefined');
                }
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('Layer 2: should preserve valid duplicates when keep is invalid', async () => {
            const suggestions = makeSuggestions(3);

            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: NaN, duplicates: [0, 2] }],
                    unique: [],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // keep=NaN → invalid, dup 0 and 2 preserved via Layer 2
                // suggestion 1 unclassified → preserved via Layer 3
                expect(result.suggestions).toHaveLength(3);
                const filenames = result.suggestions.map(
                    (s: any) => s.relevantFile,
                );
                expect(filenames).toContain('src/file-0.ts');
                expect(filenames).toContain('src/file-1.ts');
                expect(filenames).toContain('src/file-2.ts');
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('Layer 3: should keep all suggestions when all dedup indices are invalid', async () => {
            const suggestions = makeSuggestions(3);

            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [
                        { keep: NaN, duplicates: [NaN] },
                        { keep: NaN, duplicates: [NaN] },
                    ],
                    unique: [NaN],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // Layer 3: all indices invalid → addedIndices empty → all suggestions preserved
                expect(result.suggestions).toHaveLength(3);
                expect(result.trace.status).toBe('success');
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('Layer 3: should preserve unclassified suggestions not in any group or unique', async () => {
            const suggestions = makeSuggestions(3);

            // LLM returns: group with invalid keep, valid dups [0, 2], no unique
            // Suggestion 1 is not classified by any group or unique entry
            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: NaN, duplicates: [0, 2] }],
                    unique: [],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // Layer 2 adds dups 0 and 2. Layer 3 adds unclassified suggestion 1.
                expect(result.suggestions).toHaveLength(3);
                const filenames = result.suggestions.map(
                    (s: any) => s.relevantFile,
                );
                expect(filenames).toContain('src/file-0.ts');
                expect(filenames).toContain('src/file-1.ts');
                expect(filenames).toContain('src/file-2.ts');
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('should handle valid indices correctly (regression)', async () => {
            const suggestions = makeSuggestions(4);

            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [2, 3],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                expect(result.suggestions).toHaveLength(3);
                const filenames = result.suggestions.map(
                    (s: any) => s.relevantFile,
                );
                expect(filenames).toContain('src/file-0.ts');
                expect(filenames).toContain('src/file-2.ts');
                expect(filenames).toContain('src/file-3.ts');

                const file0 = result.suggestions.find(
                    (s: any) => s.relevantFile === 'src/file-0.ts',
                );
                expect(file0.suggestionContent).toContain('src/file-1.ts');
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('should not emit duplicate suggestions when index appears in both unique and group duplicates', async () => {
            const suggestions = makeSuggestions(3);

            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: NaN, duplicates: [0, 1] }],
                    unique: [0],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // If dedup succeeded: unique[0] + Layer 2 dup 1 = 2 (no dup 0)
                // If dedup failed (catch): all 3 returned
                // Either way: no crash, no empty objects, no duplicate entries
                expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
                expect(result.suggestions.length).toBeLessThanOrEqual(3);
                for (const s of result.suggestions) {
                    expect(s.relevantFile).toBeDefined();
                    expect(s.suggestionContent).not.toContain('undefined');
                }
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('should not emit duplicate when valid group keep overlaps with Layer 2 fallback', async () => {
            const suggestions = makeSuggestions(2);

            // Invalid group adds dup 0 via Layer 2, then valid group keeps 0 again
            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [
                        { keep: NaN, duplicates: [0] },
                        { keep: 0, duplicates: [1] },
                    ],
                    unique: [],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // Layer 2 adds suggestion 0 (from NaN group dup).
                // Valid group { keep: 0 } should skip (already added).
                // Layer 3: suggestion 1 classified as dup by valid group → not added.
                // Result: only suggestion 0.
                const filenames = result.suggestions.map(
                    (s: any) => s.relevantFile,
                );
                expect(
                    filenames.filter((f: string) => f === 'src/file-0.ts'),
                ).toHaveLength(1);
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });

        it('should merge duplicate locations when keep overlaps with unique', async () => {
            const suggestions = makeSuggestions(2);

            // unique[0] adds suggestion 0, then group { keep: 0, dup: [1] } is skipped
            // but "Also found in" from dup 1 should be merged into suggestion 0
            mockTracedGenerateText.mockResolvedValue({
                object: {
                    groups: [{ keep: 0, duplicates: [1] }],
                    unique: [0],
                },
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });

            const origKey = process.env.API_GOOGLE_AI_API_KEY;
            process.env.API_GOOGLE_AI_API_KEY = 'test-key';

            try {
                const result = await (stage as any).deduplicateSuggestions(
                    suggestions,
                    42,
                );

                // suggestion 0 should have "Also found in" for suggestion 1's location
                expect(result.suggestions).toHaveLength(1);
                expect(result.suggestions[0].relevantFile).toBe(
                    'src/file-0.ts',
                );
                expect(result.suggestions[0].suggestionContent).toContain(
                    'src/file-1.ts',
                );
            } finally {
                if (origKey === undefined) {
                    delete process.env.API_GOOGLE_AI_API_KEY;
                } else {
                    process.env.API_GOOGLE_AI_API_KEY = origKey;
                }
            }
        });
    });
});
