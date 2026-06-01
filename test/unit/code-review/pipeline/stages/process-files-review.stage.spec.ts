import { Test, TestingModule } from '@nestjs/testing';
import { ProcessFilesReview } from '@/code-review/pipeline/stages/process-files-review.stage';
import { SUGGESTION_SERVICE_TOKEN } from '@/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@/core/domain/interfaces/file-review-context-preparation.interface';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import { CodeAnalysisOrchestrator } from '@/ee/codeBase/codeAnalysisOrchestrator.service';
import { GraphContentFormatter } from '@/code-review/infrastructure/adapters/services/graphContentFormatter.service';
import { PriorityStatus } from '@/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { DeliveryStatus } from '@/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
    FileChange,
} from '@/core/infrastructure/config/types/general/codeReview.type';
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('ProcessFilesReview', () => {
    let stage: ProcessFilesReview;

    const mockSuggestionService = {
        filterCodeSuggestionsByReviewOptions: jest.fn(),
        filterSuggestionsCodeDiff: jest.fn(),
        getDiscardedSuggestions: jest.fn(),
        filterSuggestionsSafeGuard: jest.fn(),
        analyzeSuggestionsSeverity: jest.fn(),
        filterSuggestionsBySeverityLevel: jest.fn(),
        calculateSuggestionRankScore: jest.fn(),
        removeSuggestionsRelatedToSavedFiles: jest.fn(),
    };

    const mockPullRequestService = {
        findSuggestionsByPRAndFilename: jest.fn(),
    };

    const mockFileReviewContextPreparation = {
        prepareFileContext: jest.fn(),
    };

    const mockKodyFineTuningContextPreparation = {
        prepareKodyFineTuningContext: jest.fn(),
    };

    const mockCodeAnalysisOrchestrator = {
        executeStandardAnalysis: jest.fn(),
        executeKodyRulesAnalysis: jest.fn(),
    };

    const mockAstContentFormatter = {
        formatContent: jest.fn().mockResolvedValue(new Map()),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProcessFilesReview,
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: mockSuggestionService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestService,
                },
                {
                    provide: FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
                    useValue: mockFileReviewContextPreparation,
                },
                {
                    provide: KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
                    useValue: mockKodyFineTuningContextPreparation,
                },
                {
                    provide: CodeAnalysisOrchestrator,
                    useValue: mockCodeAnalysisOrchestrator,
                },
                {
                    provide: GraphContentFormatter,
                    useValue: mockAstContentFormatter,
                },
            ],
        }).compile();

        stage = module.get<ProcessFilesReview>(ProcessFilesReview);
        jest.clearAllMocks();
    });

    describe('processAnalysisResult - cross-file severity filtering', () => {
        /**
         * Helper to build a minimal AnalysisContext with cross-file suggestions
         * and a configured severityLevelFilter.
         */
        function buildContext(overrides: {
            severityLevelFilter?: string;
            crossFileSuggestions?: CodeSuggestion[];
        }): AnalysisContext {
            return {
                organizationAndTeamData: mockOrganizationAndTeamData as any,
                pullRequest: {
                    number: 42,
                    base: { repo: { fullName: 'org/repo' } },
                    repository: { id: 'repo-1', fullName: 'org/repo' },
                },
                platformType: 'github',
                correlationId: 'test-corr',
                reviewModeResponse: undefined,
                codeReviewConfig: {
                    reviewOptions: {},
                    suggestionControl: {
                        maxSuggestions: 10,
                        severityLevelFilter:
                            overrides.severityLevelFilter as any,
                    },
                } as any,
                fileChangeContext: {
                    file: { filename: 'src/app.ts' },
                    relevantContent: '',
                    patchWithLinesStr: '@@ -1,5 +1,5 @@\n1 +line1',
                    hasRelevantContent: true,
                },
                validCrossFileSuggestions: overrides.crossFileSuggestions || [],
            } as any;
        }

        /**
         * Helper to build cross-file CodeSuggestions with specific severities.
         */
        function buildCrossFileSuggestion(
            id: string,
            severity: string,
            filename = 'src/app.ts',
        ): CodeSuggestion {
            return {
                id,
                severity,
                label: 'cross_file',
                type: 'cross_file',
                relevantFile: filename,
                relevantLinesStart: 1,
                relevantLinesEnd: 5,
                suggestionContent: `Cross-file suggestion ${id}`,
                existingCode: 'const a = 1;',
                improvedCode: 'const a = 2;',
                oneSentenceSummary: `Summary ${id}`,
                language: 'typescript',
            } as any;
        }

        /**
         * Sets up all mocks so processAnalysisResult runs through cleanly.
         * The key behavior: suggestions pass through filters unchanged,
         * so we can verify the severity filter is the only gate.
         */
        function setupMocks(crossFileSuggestions: CodeSuggestion[]) {
            // initialFilterSuggestions: return all suggestions as filtered (no discards)
            mockSuggestionService.filterCodeSuggestionsByReviewOptions.mockReturnValue(
                {
                    codeSuggestions: crossFileSuggestions,
                },
            );
            mockSuggestionService.filterSuggestionsCodeDiff.mockReturnValue(
                crossFileSuggestions,
            );
            mockSuggestionService.getDiscardedSuggestions.mockReturnValue([]);

            // kodyFineTuning: keep all suggestions
            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                {
                    keepedSuggestions: crossFileSuggestions,
                    discardedSuggestions: [],
                },
            );

            // safeguard: return empty (only applied to non-cross-file)
            mockSuggestionService.filterSuggestionsSafeGuard.mockResolvedValue({
                suggestions: [],
                codeReviewModelUsed: { safeguard: '' },
            });

            // analyzeSuggestionsSeverity: return suggestions as-is (severity already set)
            mockSuggestionService.analyzeSuggestionsSeverity.mockImplementation(
                (_org, _pr, suggestions) => Promise.resolve(suggestions),
            );

            // kodyRules: no suggestions
            mockCodeAnalysisOrchestrator.executeKodyRulesAnalysis.mockResolvedValue(
                {
                    codeSuggestions: [],
                },
            );

            // rankScore
            mockSuggestionService.calculateSuggestionRankScore.mockResolvedValue(
                50,
            );
        }

        it('should DISCARD cross-file suggestions with medium/low severity when severityLevelFilter is "high"', async () => {
            const crossFileSuggestions = [
                buildCrossFileSuggestion('cf-1', 'critical'),
                buildCrossFileSuggestion('cf-2', 'high'),
                buildCrossFileSuggestion('cf-3', 'medium'),
                buildCrossFileSuggestion('cf-4', 'low'),
            ];

            setupMocks(crossFileSuggestions);

            // filterSuggestionsBySeverityLevel: simulate real behavior for 'high' filter
            mockSuggestionService.filterSuggestionsBySeverityLevel.mockImplementation(
                (suggestions) => {
                    const acceptedSeverities = ['critical', 'high'];
                    return Promise.resolve(
                        suggestions.map((s) => ({
                            ...s,
                            priorityStatus: acceptedSeverities.includes(
                                s.severity?.toLowerCase(),
                            )
                                ? PriorityStatus.PRIORITIZED
                                : PriorityStatus.DISCARDED_BY_SEVERITY,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                },
            );

            const context = buildContext({
                severityLevelFilter: 'high',
                crossFileSuggestions,
            });

            const emptyAIResult: AIAnalysisResult = {
                codeSuggestions: [],
            };

            // Call private method
            const result = await (stage as any).processAnalysisResult(
                emptyAIResult,
                context,
            );

            // filterSuggestionsBySeverityLevel MUST have been called with cross-file suggestions
            expect(
                mockSuggestionService.filterSuggestionsBySeverityLevel,
            ).toHaveBeenCalledWith(
                crossFileSuggestions, // the cross-file suggestions
                'high', // the severity level filter
                mockOrganizationAndTeamData,
                42, // PR number
            );

            // Only critical and high should be in the valid output
            const validIds = result.validSuggestionsToAnalyze.map((s) => s.id);
            expect(validIds).toContain('cf-1'); // critical - INCLUDED
            expect(validIds).toContain('cf-2'); // high - INCLUDED
            expect(validIds).not.toContain('cf-3'); // medium - EXCLUDED
            expect(validIds).not.toContain('cf-4'); // low - EXCLUDED

            // Discarded should include the medium/low cross-file suggestions
            const discardedIds = result.discardedSuggestionsBySafeGuard.map(
                (s) => s.id,
            );
            expect(discardedIds).toContain('cf-3');
            expect(discardedIds).toContain('cf-4');
        });

        it('should KEEP all cross-file suggestions when severityLevelFilter is not configured', async () => {
            const crossFileSuggestions = [
                buildCrossFileSuggestion('cf-1', 'critical'),
                buildCrossFileSuggestion('cf-2', 'medium'),
                buildCrossFileSuggestion('cf-3', 'low'),
            ];

            setupMocks(crossFileSuggestions);

            const context = buildContext({
                severityLevelFilter: undefined, // not configured
                crossFileSuggestions,
            });

            const emptyAIResult: AIAnalysisResult = {
                codeSuggestions: [],
            };

            const result = await (stage as any).processAnalysisResult(
                emptyAIResult,
                context,
            );

            // filterSuggestionsBySeverityLevel should NOT be called
            expect(
                mockSuggestionService.filterSuggestionsBySeverityLevel,
            ).not.toHaveBeenCalled();

            // All cross-file suggestions should be in valid output
            const validIds = result.validSuggestionsToAnalyze.map((s) => s.id);
            expect(validIds).toContain('cf-1');
            expect(validIds).toContain('cf-2');
            expect(validIds).toContain('cf-3');
        });

        it('should DISCARD only low cross-file suggestions when severityLevelFilter is "medium"', async () => {
            const crossFileSuggestions = [
                buildCrossFileSuggestion('cf-1', 'critical'),
                buildCrossFileSuggestion('cf-2', 'high'),
                buildCrossFileSuggestion('cf-3', 'medium'),
                buildCrossFileSuggestion('cf-4', 'low'),
            ];

            setupMocks(crossFileSuggestions);

            mockSuggestionService.filterSuggestionsBySeverityLevel.mockImplementation(
                (suggestions) => {
                    const acceptedSeverities = ['critical', 'high', 'medium'];
                    return Promise.resolve(
                        suggestions.map((s) => ({
                            ...s,
                            priorityStatus: acceptedSeverities.includes(
                                s.severity?.toLowerCase(),
                            )
                                ? PriorityStatus.PRIORITIZED
                                : PriorityStatus.DISCARDED_BY_SEVERITY,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                },
            );

            const context = buildContext({
                severityLevelFilter: 'medium',
                crossFileSuggestions,
            });

            const result = await (stage as any).processAnalysisResult(
                { codeSuggestions: [] } as AIAnalysisResult,
                context,
            );

            const validIds = result.validSuggestionsToAnalyze.map((s) => s.id);
            expect(validIds).toContain('cf-1'); // critical
            expect(validIds).toContain('cf-2'); // high
            expect(validIds).toContain('cf-3'); // medium
            expect(validIds).not.toContain('cf-4'); // low - EXCLUDED

            const discardedIds = result.discardedSuggestionsBySafeGuard.map(
                (s) => s.id,
            );
            expect(discardedIds).toContain('cf-4');
        });

        it('should not filter cross-file suggestions that do not match the current file', async () => {
            const crossFileSuggestions = [
                buildCrossFileSuggestion('cf-1', 'medium', 'src/app.ts'), // matches file
                buildCrossFileSuggestion('cf-2', 'medium', 'src/other-file.ts'), // different file
            ];

            // Only cf-1 matches the file being analyzed (src/app.ts).
            // cf-2 should not appear at all since it's for a different file.
            const matchingOnly = [crossFileSuggestions[0]];

            setupMocks(matchingOnly);

            mockSuggestionService.filterSuggestionsBySeverityLevel.mockImplementation(
                (suggestions) => {
                    return Promise.resolve(
                        suggestions.map((s) => ({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SEVERITY,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                },
            );

            const context = buildContext({
                severityLevelFilter: 'high',
                crossFileSuggestions,
            });

            const result = await (stage as any).processAnalysisResult(
                { codeSuggestions: [] } as AIAnalysisResult,
                context,
            );

            // filterSuggestionsBySeverityLevel should only receive the file-matching suggestion
            expect(
                mockSuggestionService.filterSuggestionsBySeverityLevel,
            ).toHaveBeenCalledTimes(1);
            const calledWith =
                mockSuggestionService.filterSuggestionsBySeverityLevel.mock
                    .calls[0][0];
            expect(calledWith).toHaveLength(1);
            expect(calledWith[0].id).toBe('cf-1');

            // No cross-file suggestions should be in the valid output (both excluded)
            const validIds = result.validSuggestionsToAnalyze.map((s) => s.id);
            expect(validIds).not.toContain('cf-1'); // discarded by severity
            expect(validIds).not.toContain('cf-2'); // different file, never processed
        });
    });

    describe('AST content formatter integration in processSingleBatch', () => {
        function createFile(filename: string): FileChange {
            return {
                content: null,
                sha: 'abc',
                filename,
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                blob_url: '',
                raw_url: '',
                contents_url: '',
                patch: '@@ -1,3 +1,3 @@\n-old\n+new',
                fileContent: `original content of ${filename}`,
            } as FileChange;
        }

        function createBatchContext(): AnalysisContext {
            return {
                organizationAndTeamData: mockOrganizationAndTeamData as any,
                pullRequest: {
                    number: 42,
                    base: { repo: { fullName: 'org/repo' } },
                    repository: { id: 'repo-1', fullName: 'org/repo' },
                },
                platformType: 'github',
                codeReviewConfig: { reviewOptions: {} } as any,
            } as any;
        }

        it('should attach AST formatted content to files when AST returns results', async () => {
            const file = createFile('src/app.ts');
            const astResultMap = new Map([
                [
                    'src/app.ts',
                    {
                        content: 'AST formatted content',
                        flag: 'DIFF',
                    },
                ],
            ]);
            mockAstContentFormatter.formatContent.mockResolvedValue(
                astResultMap,
            );

            // prepareFileContext captures the file passed to it
            let capturedFile: FileChange | null = null;
            mockFileReviewContextPreparation.prepareFileContext.mockImplementation(
                (f: FileChange, ctx: AnalysisContext) => {
                    capturedFile = { ...f }; // snapshot before cleanup
                    return Promise.resolve({
                        fileContext: {
                            ...ctx,
                            fileChangeContext: {
                                file: f,
                                relevantContent:
                                    f.astFormattedContent || f.fileContent,
                                patchWithLinesStr:
                                    '@@ -1,3 +1,3 @@\n-old\n+new',
                                hasRelevantContent: !!f.astFormattedContent,
                            },
                        },
                    });
                },
            );

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterCodeSuggestionsByReviewOptions.mockReturnValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsCodeDiff.mockReturnValue([]);
            mockSuggestionService.getDiscardedSuggestions.mockReturnValue([]);
            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                { keepedSuggestions: [], discardedSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsSafeGuard.mockResolvedValue({
                suggestions: [],
                codeReviewModelUsed: { safeguard: '' },
            });
            mockSuggestionService.analyzeSuggestionsSeverity.mockResolvedValue(
                [],
            );
            mockCodeAnalysisOrchestrator.executeKodyRulesAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            const context = createBatchContext();

            await (stage as any).processSingleBatch([file], context, 0);

            // prepareFileContext should have received the file WITH astFormattedContent
            expect(capturedFile).not.toBeNull();
            expect(capturedFile!.astFormattedContent).toBe(
                'AST formatted content',
            );
        });

        it('should NOT attach AST content when AST returns empty map (fallback)', async () => {
            const file = createFile('src/app.ts');
            mockAstContentFormatter.formatContent.mockResolvedValue(
                new Map(),
            );

            let capturedFile: FileChange | null = null;
            mockFileReviewContextPreparation.prepareFileContext.mockImplementation(
                (f: FileChange, ctx: AnalysisContext) => {
                    capturedFile = { ...f };
                    return Promise.resolve({
                        fileContext: {
                            ...ctx,
                            fileChangeContext: {
                                file: f,
                                relevantContent: f.fileContent,
                                patchWithLinesStr:
                                    '@@ -1,3 +1,3 @@\n-old\n+new',
                                hasRelevantContent: false,
                            },
                        },
                    });
                },
            );

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterCodeSuggestionsByReviewOptions.mockReturnValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsCodeDiff.mockReturnValue([]);
            mockSuggestionService.getDiscardedSuggestions.mockReturnValue([]);
            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                { keepedSuggestions: [], discardedSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsSafeGuard.mockResolvedValue({
                suggestions: [],
                codeReviewModelUsed: { safeguard: '' },
            });
            mockSuggestionService.analyzeSuggestionsSeverity.mockResolvedValue(
                [],
            );
            mockCodeAnalysisOrchestrator.executeKodyRulesAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            const context = createBatchContext();

            await (stage as any).processSingleBatch([file], context, 0);

            // File should NOT have astFormattedContent
            expect(capturedFile).not.toBeNull();
            expect(capturedFile!.astFormattedContent).toBeUndefined();
        });

        it('should clean up astFormattedContent from files after filterAndPrepareFiles', async () => {
            const file1 = createFile('src/a.ts');
            const file2 = createFile('src/b.ts');

            const astResultMap = new Map([
                [
                    'src/a.ts',
                    { content: 'formatted a', flag: 'DIFF' },
                ],
                [
                    'src/b.ts',
                    { content: 'formatted b', flag: 'FULL' },
                ],
            ]);
            mockAstContentFormatter.formatContent.mockResolvedValue(
                astResultMap,
            );

            mockFileReviewContextPreparation.prepareFileContext.mockImplementation(
                (f: FileChange, ctx: AnalysisContext) => {
                    return Promise.resolve({
                        fileContext: {
                            ...ctx,
                            fileChangeContext: {
                                file: f,
                                relevantContent:
                                    f.astFormattedContent || f.fileContent,
                                patchWithLinesStr:
                                    '@@ -1,3 +1,3 @@\n-old\n+new',
                                hasRelevantContent: !!f.astFormattedContent,
                            },
                        },
                    });
                },
            );

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterCodeSuggestionsByReviewOptions.mockReturnValue(
                { codeSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsCodeDiff.mockReturnValue([]);
            mockSuggestionService.getDiscardedSuggestions.mockReturnValue([]);
            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                { keepedSuggestions: [], discardedSuggestions: [] },
            );
            mockSuggestionService.filterSuggestionsSafeGuard.mockResolvedValue({
                suggestions: [],
                codeReviewModelUsed: { safeguard: '' },
            });
            mockSuggestionService.analyzeSuggestionsSeverity.mockResolvedValue(
                [],
            );
            mockCodeAnalysisOrchestrator.executeKodyRulesAnalysis.mockResolvedValue(
                { codeSuggestions: [] },
            );
            const batch = [file1, file2];
            const context = createBatchContext();

            await (stage as any).processSingleBatch(batch, context, 0);

            // After processSingleBatch, astFormattedContent must be deleted from all files
            expect(file1.astFormattedContent).toBeUndefined();
            expect(file2.astFormattedContent).toBeUndefined();

            // But original fileContent must still be intact
            expect(file1.fileContent).toBe('original content of src/a.ts');
            expect(file2.fileContent).toBe('original content of src/b.ts');
        });
    });

    // ─── Frozen object safety (Zod v4 regression guard) ──────────────────

    describe('frozen object safety — applyKodyFineTuningFilter', () => {
        it('should not throw when discarded suggestions are frozen (Object.freeze)', async () => {
            const frozenDiscarded = Object.freeze({
                id: 'd1',
                severity: 'low',
                label: 'code_style',
            });

            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                {
                    keepedSuggestions: [{ id: 'k1', severity: 'high' }],
                    discardedSuggestions: [frozenDiscarded],
                },
            );

            const context = {
                organizationAndTeamData: mockOrganizationAndTeamData,
                pullRequest: {
                    number: 42,
                    repository: { id: 'repo-1', fullName: 'org/repo' },
                },
                codeReviewConfig: {
                    kodyFineTuningConfig: { enabled: true },
                },
                clusterizedSuggestions: [],
            };

            const result = await (stage as any).applyKodyFineTuningFilter(
                [{ id: 'k1' }, frozenDiscarded],
                context,
            );

            expect(result.keepedSuggestions).toHaveLength(1);
            expect(result.discardedSuggestionsByKodyFineTuning).toHaveLength(1);
            expect(
                result.discardedSuggestionsByKodyFineTuning[0].priorityStatus,
            ).toBe(PriorityStatus.DISCARDED_BY_KODY_FINE_TUNING);
        });

        it('should not mutate the original frozen discarded suggestion', async () => {
            const frozenDiscarded = Object.freeze({
                id: 'd1',
                severity: 'low',
            });

            mockKodyFineTuningContextPreparation.prepareKodyFineTuningContext.mockResolvedValue(
                {
                    keepedSuggestions: [],
                    discardedSuggestions: [frozenDiscarded],
                },
            );

            const context = {
                organizationAndTeamData: mockOrganizationAndTeamData,
                pullRequest: {
                    number: 1,
                    repository: { id: 'r1', fullName: 'o/r' },
                },
                codeReviewConfig: {},
                clusterizedSuggestions: [],
            };

            const result = await (stage as any).applyKodyFineTuningFilter(
                [frozenDiscarded],
                context,
            );

            // Must be a new object, not the same frozen reference
            expect(result.discardedSuggestionsByKodyFineTuning[0]).not.toBe(
                frozenDiscarded,
            );
            // Original must remain unchanged
            expect((frozenDiscarded as any).priorityStatus).toBeUndefined();
        });
    });
});
