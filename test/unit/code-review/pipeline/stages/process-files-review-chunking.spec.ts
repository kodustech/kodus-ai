import { Test, TestingModule } from '@nestjs/testing';
import { ProcessFilesReview } from '@libs/code-review/pipeline/stages/process-files-review.stage';
import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import { GraphContentFormatter } from '@libs/code-review/infrastructure/adapters/services/graphContentFormatter.service';
import {
    AnalysisContext,
    CodeSuggestion,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

// Mock logger
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a string of approximately `tokenCount` tokens (1 token ≈ 3.5 chars).
 *  Each line is unique (includes seed + line number) so chunks are distinguishable. */
function generateContent(tokenCount: number, seed = 'file'): string {
    const charCount = Math.floor(tokenCount * 3.5);
    const lines: string[] = [];
    let total = 0;
    let lineNum = 0;
    while (total < charCount) {
        const prefix = `${seed}_L${lineNum++}_`;
        const padding = 'x'.repeat(Math.max(0, 70 - prefix.length));
        const line = prefix + padding;
        lines.push(line);
        total += line.length + 1; // +1 for \n
    }
    return lines.join('\n').slice(0, charCount);
}

function makeSuggestion(id: string, file: string): Partial<CodeSuggestion> {
    return {
        id,
        relevantFile: file,
        language: 'typescript',
        suggestionContent: `suggestion ${id}`,
        existingCode: 'old',
        improvedCode: 'new',
    };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSuggestionService = {
    filterCodeSuggestionsByReviewOptions: jest.fn((_opts, result) => result),
    filterSuggestionsCodeDiff: jest.fn((_patch, suggestions) => suggestions),
    getDiscardedSuggestions: jest.fn((..._args: any[]) => []),
    filterSuggestionsSafeGuard: jest.fn(),
    analyzeSuggestionsSeverity: jest.fn(
        (_org, _pr, suggestions) => suggestions,
    ),
    filterSuggestionsBySeverityLevel: jest.fn((suggestions) =>
        suggestions.map((s: any) => ({
            ...s,
            priorityStatus: PriorityStatus.PRIORITIZED,
        })),
    ),
    removeSuggestionsRelatedToSavedFiles: jest.fn(
        (_org, _pr, _saved, suggestions) => suggestions,
    ),
    calculateSuggestionRankScore: jest.fn(() => 1),
};

const mockCodeAnalysisOrchestrator = {
    executeStandardAnalysis: jest.fn(),
    executeKodyRulesAnalysis: jest.fn(() => ({ codeSuggestions: [] })),
};

const mockPullRequestService = {
    findSuggestionsByPRAndFilename: jest.fn(() => []),
};

const mockFileReviewContextPreparation = {
    prepareFileReviewContext: jest.fn(),
};

const mockKodyFineTuningContextPreparation = {
    prepareKodyFineTuningContext: jest.fn(
        (_orgId, _pr, _repo, suggestions) => ({
            keepedSuggestions: suggestions,
            discardedSuggestions: [],
        }),
    ),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ProcessFilesReview – file content chunking', () => {
    let stage: ProcessFilesReview;

    // We need access to private methods, so cast through `any`
    let stageAny: any;

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
                    useValue: {
                        formatContent: jest.fn().mockResolvedValue(new Map()),
                    },
                },
            ],
        }).compile();

        stage = module.get<ProcessFilesReview>(ProcessFilesReview);
        stageAny = stage as any;

        jest.clearAllMocks();

        // Default: safeguard passes all suggestions through
        mockSuggestionService.filterSuggestionsSafeGuard.mockImplementation(
            (_org, _pr, _file, _content, _patch, suggestions) => ({
                suggestions,
                codeReviewModelUsed: { safeguard: 'mock-safeguard' },
            }),
        );
    });

    // -----------------------------------------------------------------
    // Helpers to build context
    // -----------------------------------------------------------------

    function makeFileChange(
        filename: string,
        fileContent: string,
        patch = '+ added line',
    ) {
        return {
            filename,
            fileContent,
            patch,
            patchWithLinesStr: patch,
            status: 'modified',
        };
    }

    function makeAnalysisContext(
        file: any,
        overrides: Partial<AnalysisContext> = {},
    ): AnalysisContext {
        return {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: {
                number: 42,
                title: 'Test PR',
                body: 'PR body',
                base: { repo: { fullName: 'org/repo' }, ref: 'main' },
                repository: { id: 'repo-1', fullName: 'org/repo' },
                isDraft: false,
                stats: {
                    total_additions: 10,
                    total_deletions: 5,
                    total_files: 4,
                    total_lines_changed: 15,
                },
            },
            repository: { id: 'repo-1', name: 'test-repo' } as any,
            platformType: 'github',
            action: 'opened',
            codeReviewConfig: {
                reviewOptions: {},
                pullRequestApprovalActive: false,
                kodusConfigFileOverridesWebPreferences: false,
            } as any,
            reviewModeResponse: { isReviewMode: false },
            fileChangeContext: {
                file,
                relevantContent: file.fileContent,
                patchWithLinesStr: file.patchWithLinesStr || file.patch,
                hasRelevantContent: true,
            },
            ...overrides,
        } as any;
    }

    // -----------------------------------------------------------------
    // 1. No chunking — normal flow
    // -----------------------------------------------------------------

    describe('when maxInputTokens is NOT configured', () => {
        it('should call executeStandardAnalysis once and safeguard once per file', async () => {
            const file = makeFileChange('small.ts', 'const a = 1;');
            const context = makeAnalysisContext(file);

            const suggestion = makeSuggestion('s1', 'small.ts');

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValueOnce(
                {
                    codeSuggestions: [suggestion],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                },
            );

            const result = await stageAny.executeFileAnalysis(context);

            expect(
                mockCodeAnalysisOrchestrator.executeStandardAnalysis,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(1);

            // Safeguard received the full file content
            const safeguardCall =
                mockSuggestionService.filterSuggestionsSafeGuard.mock.calls[0];
            expect(safeguardCall[3]).toBe('const a = 1;'); // relevantContent arg

            expect(
                result.validSuggestionsToAnalyze.length,
            ).toBeGreaterThanOrEqual(1);
        });
    });

    describe('when maxInputTokens is set but file fits in budget', () => {
        it('should NOT split and call analyze + safeguard once', async () => {
            const file = makeFileChange('fits.ts', 'const a = 1;');
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 100000 },
                    },
                } as any,
            });

            const suggestion = makeSuggestion('s1', 'fits.ts');

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValueOnce(
                {
                    codeSuggestions: [suggestion],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                },
            );

            const result = await stageAny.executeFileAnalysis(context);

            expect(
                mockCodeAnalysisOrchestrator.executeStandardAnalysis,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(1);
            expect(result.validSuggestionsToAnalyze).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------
    // 2. Chunking — same chunks for analyze and safeguard
    // -----------------------------------------------------------------

    describe('when file needs to be split into chunks', () => {
        // Budget: 10000 tokens with 10% margin → effective 9000
        // Fixed overhead: ~5200 tokens (system prompt base)
        // Available for content: ~3800 tokens
        // File with ~10000 tokens → needs ~3 chunks
        const MAX_INPUT_TOKENS = 10000;

        function makeChunkingContext(file: any): AnalysisContext {
            return makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: MAX_INPUT_TOKENS },
                    },
                } as any,
            });
        }

        it('should call analyze and safeguard once per chunk with the SAME chunk content', async () => {
            // ~10000 tokens of content, budget allows ~3800 per chunk → ~3 chunks
            const largeContent = generateContent(10000);
            const file = makeFileChange('large.ts', largeContent);
            const context = makeChunkingContext(file);

            // Each chunk analysis returns 1 suggestion
            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async (_org, _pr, _fileContext) => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'large.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            const result = await stageAny.executeFileAnalysis(context);

            const analyzeCallCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;
            const safeguardCallCount =
                mockSuggestionService.filterSuggestionsSafeGuard.mock.calls
                    .length;

            // analyze and safeguard must be called the same number of times
            expect(analyzeCallCount).toBeGreaterThan(1);
            expect(safeguardCallCount).toBe(analyzeCallCount);

            // Verify each chunk sent to analyze is the SAME chunk sent to safeguard
            for (let i = 0; i < analyzeCallCount; i++) {
                const analyzeChunk =
                    mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock
                        .calls[i][2].relevantContent; // fileContext.relevantContent
                const safeguardChunk =
                    mockSuggestionService.filterSuggestionsSafeGuard.mock.calls[
                        i
                    ][3]; // relevantContent arg (4th)

                expect(analyzeChunk).toBe(safeguardChunk);
                expect(analyzeChunk.length).toBeGreaterThan(0);
                // Each chunk must be smaller than the full content
                expect(analyzeChunk.length).toBeLessThan(largeContent.length);
            }

            // All suggestions from all chunks are merged
            expect(result.validSuggestionsToAnalyze.length).toBe(
                analyzeCallCount,
            );
        });

        it('should split into 3 chunks for a file needing 3 parts', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('three-chunks.ts', largeContent);
            const context = makeChunkingContext(file);

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'three-chunks.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            // With these numbers we expect 3 chunks (10000 content tokens,
            // ~3800 available → ceil(10000/3800) = 3)
            expect(chunkCount).toBe(3);
        });

        it('should split into 2 chunks for a file needing 2 parts', async () => {
            // Smaller file: ~7000 tokens, budget ~3800 → 2 chunks
            const content = generateContent(7000);
            const file = makeFileChange('two-chunks.ts', content);
            const context = makeChunkingContext(file);

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'two-chunks.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            expect(chunkCount).toBe(2);
        });

        it('should merge suggestions from all chunks into a single result', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('merged.ts', largeContent);
            const context = makeChunkingContext(file);

            let callIdx = 0;
            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => {
                    callIdx++;
                    // Each chunk produces 2 suggestions
                    return {
                        codeSuggestions: [
                            makeSuggestion(`chunk${callIdx}-s1`, 'merged.ts'),
                            makeSuggestion(`chunk${callIdx}-s2`, 'merged.ts'),
                        ],
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            const result = await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            // 2 suggestions per chunk × N chunks
            expect(result.validSuggestionsToAnalyze.length).toBe(
                chunkCount * 2,
            );
        });

        it('should merge discarded suggestions from all chunk safeguards', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('discarded.ts', largeContent);
            const context = makeChunkingContext(file);

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'discarded.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            // Safeguard discards all suggestions (returns empty)
            mockSuggestionService.filterSuggestionsSafeGuard.mockImplementation(
                (_org, _pr, _file, _content, _patch, _suggestions) => ({
                    suggestions: [],
                    codeReviewModelUsed: { safeguard: 'mock-safeguard' },
                }),
            );

            // getDiscardedSuggestions returns the input suggestions as discarded
            mockSuggestionService.getDiscardedSuggestions.mockImplementation(
                (input, _kept, _status) =>
                    input.map((s: any) => ({
                        ...s,
                        priorityStatus: PriorityStatus.DISCARDED_BY_SAFEGUARD,
                    })),
            );

            const result = await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            expect(result.validSuggestionsToAnalyze).toHaveLength(0);
            expect(
                result.discardedSuggestionsBySafeGuard.length,
            ).toBeGreaterThanOrEqual(chunkCount);
        });
    });

    // -----------------------------------------------------------------
    // 3. Chunking with AST markers
    // -----------------------------------------------------------------

    describe('when file has AST markers', () => {
        it('should split at AST marker boundaries', async () => {
            // Create content with CUT markers — 4 sections, budget fits ~1 section
            const sections = Array.from(
                { length: 4 },
                (_, i) => `section${i}_${'a'.repeat(3500 * 3 - 10)}`,
            );
            const contentWithMarkers = sections.join('<- CUT CONTENT ->');

            const file = makeFileChange('ast-file.ts', contentWithMarkers);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 10000 },
                    },
                } as any,
            });

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'ast-file.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            expect(chunkCount).toBeGreaterThan(1);

            // Verify chunks don't have partial CUT markers (split happened at marker boundaries)
            for (let i = 0; i < chunkCount; i++) {
                const chunk =
                    mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock
                        .calls[i][2].relevantContent;
                // If a chunk contains the marker, it should be complete (not partial)
                if (chunk.includes('<- CUT')) {
                    expect(chunk).toContain('<- CUT CONTENT ->');
                }
            }
        });
    });

    // -----------------------------------------------------------------
    // 4. Best-effort: even 25% doesn't fit
    // -----------------------------------------------------------------

    describe('when even 25% of the file does not fit in budget', () => {
        it('should NOT split and send full content (best-effort)', async () => {
            // Massive file: 100000 tokens, tiny budget: 1000 tokens
            // 25% = 25000 tokens >> 1000 available → no split
            const hugeContent = generateContent(100000);
            const file = makeFileChange('huge.ts', hugeContent);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 1000 },
                    },
                } as any,
            });

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockResolvedValueOnce(
                {
                    codeSuggestions: [makeSuggestion('s1', 'huge.ts')],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                },
            );

            await stageAny.executeFileAnalysis(context);

            // Should NOT chunk — single call
            expect(
                mockCodeAnalysisOrchestrator.executeStandardAnalysis,
            ).toHaveBeenCalledTimes(1);
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(1);

            // Safeguard gets the FULL content
            const safeguardContent =
                mockSuggestionService.filterSuggestionsSafeGuard.mock
                    .calls[0][3];
            expect(safeguardContent).toBe(hugeContent);
        });
    });

    // -----------------------------------------------------------------
    // 5. Full PR simulation: 4 files, mixed chunking
    // -----------------------------------------------------------------

    describe('full PR simulation: 4 files with mixed chunking', () => {
        it('should handle 2 normal files + 1 file with 3 chunks + 1 file with 2 chunks', async () => {
            const MAX_INPUT_TOKENS = 10000;

            // Small files that fit in budget (~100 tokens each)
            const smallFile1 = makeFileChange(
                'small1.ts',
                'const x = 1;\n'.repeat(10),
            );
            const smallFile2 = makeFileChange(
                'small2.ts',
                'const y = 2;\n'.repeat(10),
            );

            // Large file needing 3 chunks (~10000 tokens)
            const largeContent3Chunks = generateContent(10000, 'large3');
            const largeFile3 = makeFileChange(
                'large3chunks.ts',
                largeContent3Chunks,
            );

            // Medium file needing 2 chunks (~7000 tokens)
            const mediumContent2Chunks = generateContent(7000, 'medium2');
            const largeFile2 = makeFileChange(
                'large2chunks.ts',
                mediumContent2Chunks,
            );

            const files = [smallFile1, smallFile2, largeFile3, largeFile2];

            // Track all analyze calls with their file and content
            const analyzeCalls: {
                filename: string;
                relevantContent: string;
            }[] = [];
            const safeguardCalls: {
                filename: string;
                relevantContent: string;
            }[] = [];

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async (_org, _pr, fileContext) => {
                    analyzeCalls.push({
                        filename: fileContext.file.filename,
                        relevantContent: fileContext.relevantContent,
                    });
                    return {
                        codeSuggestions: [
                            makeSuggestion(
                                `s-${analyzeCalls.length}`,
                                fileContext.file.filename,
                            ),
                        ],
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            mockSuggestionService.filterSuggestionsSafeGuard.mockImplementation(
                (_org, _pr, file, content, _patch, suggestions) => {
                    safeguardCalls.push({
                        filename: file.filename,
                        relevantContent: content,
                    });
                    return {
                        suggestions,
                        codeReviewModelUsed: { safeguard: 'mock-safeguard' },
                    };
                },
            );

            // Execute all 4 files
            const results: any[] = [];
            for (const file of files) {
                const context = makeAnalysisContext(file, {
                    codeReviewConfig: {
                        reviewOptions: {},
                        pullRequestApprovalActive: false,
                        kodusConfigFileOverridesWebPreferences: false,
                        byokConfig: {
                            main: { maxInputTokens: MAX_INPUT_TOKENS },
                        },
                    } as any,
                });

                const result = await stageAny.executeFileAnalysis(context);
                results.push(result);
            }

            // --- Verify small files: 1 analyze + 1 safeguard each ---
            const small1AnalyzeCalls = analyzeCalls.filter(
                (c) => c.filename === 'small1.ts',
            );
            const small1SafeguardCalls = safeguardCalls.filter(
                (c) => c.filename === 'small1.ts',
            );
            expect(small1AnalyzeCalls).toHaveLength(1);
            expect(small1SafeguardCalls).toHaveLength(1);
            // Full content passed (no chunking)
            expect(small1AnalyzeCalls[0].relevantContent).toBe(
                smallFile1.fileContent,
            );
            expect(small1SafeguardCalls[0].relevantContent).toBe(
                smallFile1.fileContent,
            );

            const small2AnalyzeCalls = analyzeCalls.filter(
                (c) => c.filename === 'small2.ts',
            );
            const small2SafeguardCalls = safeguardCalls.filter(
                (c) => c.filename === 'small2.ts',
            );
            expect(small2AnalyzeCalls).toHaveLength(1);
            expect(small2SafeguardCalls).toHaveLength(1);

            // --- Verify large file with 3 chunks ---
            const large3AnalyzeCalls = analyzeCalls.filter(
                (c) => c.filename === 'large3chunks.ts',
            );
            const large3SafeguardCalls = safeguardCalls.filter(
                (c) => c.filename === 'large3chunks.ts',
            );
            expect(large3AnalyzeCalls).toHaveLength(3);
            expect(large3SafeguardCalls).toHaveLength(3);

            // Same chunks in analyze and safeguard
            for (let i = 0; i < 3; i++) {
                expect(large3AnalyzeCalls[i].relevantContent).toBe(
                    large3SafeguardCalls[i].relevantContent,
                );
            }

            // Chunks are different from each other
            expect(large3AnalyzeCalls[0].relevantContent).not.toBe(
                large3AnalyzeCalls[1].relevantContent,
            );

            // Merged result has 3 suggestions (1 per chunk)
            const large3Result = results[2];
            expect(large3Result.filename).toBe('large3chunks.ts');
            expect(large3Result.validSuggestionsToAnalyze).toHaveLength(3);

            // --- Verify medium file with 2 chunks ---
            const large2AnalyzeCalls = analyzeCalls.filter(
                (c) => c.filename === 'large2chunks.ts',
            );
            const large2SafeguardCalls = safeguardCalls.filter(
                (c) => c.filename === 'large2chunks.ts',
            );
            expect(large2AnalyzeCalls).toHaveLength(2);
            expect(large2SafeguardCalls).toHaveLength(2);

            // Same chunks in analyze and safeguard
            for (let i = 0; i < 2; i++) {
                expect(large2AnalyzeCalls[i].relevantContent).toBe(
                    large2SafeguardCalls[i].relevantContent,
                );
            }

            // Merged result has 2 suggestions (1 per chunk)
            const large2Result = results[3];
            expect(large2Result.filename).toBe('large2chunks.ts');
            expect(large2Result.validSuggestionsToAnalyze).toHaveLength(2);

            // --- Total calls across all files ---
            // 2 small (1 each) + 3 chunks + 2 chunks = 7
            expect(analyzeCalls).toHaveLength(7);
            expect(safeguardCalls).toHaveLength(7);
        });
    });

    // -----------------------------------------------------------------
    // 6. Max 4 chunks cap
    // -----------------------------------------------------------------

    describe('chunk cap at 4', () => {
        it('should never produce more than 4 chunks even when raw split yields more', async () => {
            // We need content where:
            //   - 25% fits in budget (passes the guard)
            //   - but line-boundary waste causes >4 raw chunks
            //
            // With maxInputTokens=6000:
            //   effectiveBudget = floor(6000*0.9) = 5400
            //   fixedTokens ≈ 5206 (5000 base + 200 wrapper + ~6 for patch/summary)
            //   availableTokens ≈ 194
            //   maxCharsPerChunk = floor(194*3.5) = 679
            //
            // Content: 6 lines of ~400 chars each ≈ 2406 chars ≈ 688 tokens
            //   minChunkTokens = ceil(688/4) = 172 ≤ 194 → 25% fits ✓
            //   Two lines = ~801 chars > 679 → each line is its own chunk → 6 raw chunks
            //   Capped to 4
            const lines: string[] = [];
            for (let i = 0; i < 6; i++) {
                lines.push(`capped_line${i}_${'z'.repeat(380)}`);
            }
            const content = lines.join('\n');

            const file = makeFileChange('capped.ts', content);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 6000 },
                    },
                } as any,
            });

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [
                        makeSuggestion(
                            `s-${mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls.length}`,
                            'capped.ts',
                        ),
                    ],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            await stageAny.executeFileAnalysis(context);

            expect(
                mockCodeAnalysisOrchestrator.executeStandardAnalysis,
            ).toHaveBeenCalledTimes(4);
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(4);
        });
    });

    // -----------------------------------------------------------------
    // 7. Chunk that produces no suggestions
    // -----------------------------------------------------------------

    describe('when a chunk produces no suggestions', () => {
        it('should merge correctly with empty arrays from some chunks', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('partial.ts', largeContent);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 10000 },
                    },
                } as any,
            });

            let callIdx = 0;
            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => {
                    callIdx++;
                    // Only odd chunks produce suggestions, even chunks return empty
                    const suggestions =
                        callIdx % 2 === 1
                            ? [makeSuggestion(`s-${callIdx}`, 'partial.ts')]
                            : [];
                    return {
                        codeSuggestions: suggestions,
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            const result = await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            expect(chunkCount).toBeGreaterThan(1);

            // analyze and safeguard still called for every chunk (even empty ones)
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(chunkCount);

            // Only chunks with odd index produced suggestions
            const expectedSuggestions = Math.ceil(chunkCount / 2);
            expect(result.validSuggestionsToAnalyze).toHaveLength(
                expectedSuggestions,
            );

            // Result should not contain undefined or null entries
            expect(
                result.validSuggestionsToAnalyze.every(
                    (s: any) => s != null && s.id,
                ),
            ).toBe(true);
        });

        it('should return empty suggestions when ALL chunks produce nothing', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('empty-all.ts', largeContent);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 10000 },
                    },
                } as any,
            });

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => ({
                    codeSuggestions: [],
                    codeReviewModelUsed: {
                        generateSuggestions: 'mock-model',
                    },
                }),
            );

            const result = await stageAny.executeFileAnalysis(context);

            const chunkCount =
                mockCodeAnalysisOrchestrator.executeStandardAnalysis.mock.calls
                    .length;

            expect(chunkCount).toBeGreaterThan(1);
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(chunkCount);
            expect(result.validSuggestionsToAnalyze).toHaveLength(0);
            expect(result.filename).toBe('empty-all.ts');
        });
    });

    // -----------------------------------------------------------------
    // 8. Error in one chunk fails the entire file
    // -----------------------------------------------------------------

    describe('when a chunk fails with an error', () => {
        it('should fail the entire file and return error result', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('error-file.ts', largeContent);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 10000 },
                    },
                } as any,
            });

            let callIdx = 0;
            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => {
                    callIdx++;
                    if (callIdx === 2) {
                        throw new Error('LLM rate limit exceeded');
                    }
                    return {
                        codeSuggestions: [
                            makeSuggestion(`s-${callIdx}`, 'error-file.ts'),
                        ],
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            const result = await stageAny.executeFileAnalysis(context);

            // The file should have an error
            expect(result.error).toBeDefined();
            expect(result.error.error.message).toContain(
                'LLM rate limit exceeded',
            );
            expect(result.filename).toBe('error-file.ts');

            // No suggestions should be returned (whole file failed)
            expect(result.validSuggestionsToAnalyze).toHaveLength(0);
            expect(result.discardedSuggestionsBySafeGuard).toHaveLength(0);
        });

        it('should not call safeguard for chunks after the failing one', async () => {
            const largeContent = generateContent(10000);
            const file = makeFileChange('error-mid.ts', largeContent);
            const context = makeAnalysisContext(file, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: 10000 },
                    },
                } as any,
            });

            let callIdx = 0;
            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async () => {
                    callIdx++;
                    if (callIdx === 2) {
                        throw new Error('Chunk 2 exploded');
                    }
                    return {
                        codeSuggestions: [
                            makeSuggestion(`s-${callIdx}`, 'error-mid.ts'),
                        ],
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            await stageAny.executeFileAnalysis(context);

            // Chunk 1 succeeded → analyze + safeguard called
            // Chunk 2 failed at analyze → no safeguard for chunk 2+
            // Sequential processing means chunk 3 never runs
            expect(
                mockCodeAnalysisOrchestrator.executeStandardAnalysis,
            ).toHaveBeenCalledTimes(2); // chunk 1 ok, chunk 2 throws
            expect(
                mockSuggestionService.filterSuggestionsSafeGuard,
            ).toHaveBeenCalledTimes(1); // only chunk 1's safeguard ran
        });
    });

    // -----------------------------------------------------------------
    // 9. Concurrency: chunked files in the same batch don't interfere
    // -----------------------------------------------------------------

    describe('concurrent chunked files in a batch', () => {
        it('should keep chunks isolated per file when multiple chunked files run concurrently', async () => {
            const MAX_INPUT_TOKENS = 10000;

            // Two large files that both need chunking (unique seeds → unique content)
            const contentA = generateContent(10000, 'fileA');
            const contentB = generateContent(7000, 'fileB');
            const fileA = makeFileChange('fileA.ts', contentA);
            const fileB = makeFileChange('fileB.ts', contentB);

            // Track calls per file
            const analyzeByFile: Record<string, string[]> = {};
            const safeguardByFile: Record<string, string[]> = {};

            mockCodeAnalysisOrchestrator.executeStandardAnalysis.mockImplementation(
                async (_org, _pr, fileContext) => {
                    const fname = fileContext.file.filename;
                    const content = fileContext.relevantContent;
                    analyzeByFile[fname] = analyzeByFile[fname] || [];
                    analyzeByFile[fname].push(content);

                    // Small delay to simulate real async interleaving
                    await new Promise((r) => setTimeout(r, 5));

                    return {
                        codeSuggestions: [
                            makeSuggestion(
                                `${fname}-s${analyzeByFile[fname].length}`,
                                fname,
                            ),
                        ],
                        codeReviewModelUsed: {
                            generateSuggestions: 'mock-model',
                        },
                    };
                },
            );

            mockSuggestionService.filterSuggestionsSafeGuard.mockImplementation(
                (_org, _pr, file, content, _patch, suggestions) => {
                    const fname = file.filename;
                    safeguardByFile[fname] = safeguardByFile[fname] || [];
                    safeguardByFile[fname].push(content);
                    return {
                        suggestions,
                        codeReviewModelUsed: { safeguard: 'mock-safeguard' },
                    };
                },
            );

            // Run both files concurrently (simulating pLimit behavior)
            const contextA = makeAnalysisContext(fileA, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: MAX_INPUT_TOKENS },
                    },
                } as any,
            });
            const contextB = makeAnalysisContext(fileB, {
                codeReviewConfig: {
                    reviewOptions: {},
                    pullRequestApprovalActive: false,
                    kodusConfigFileOverridesWebPreferences: false,
                    byokConfig: {
                        main: { maxInputTokens: MAX_INPUT_TOKENS },
                    },
                } as any,
            });

            const [resultA, resultB] = await Promise.all([
                stageAny.executeFileAnalysis(contextA),
                stageAny.executeFileAnalysis(contextB),
            ]);

            // --- File A: should have 3 chunks ---
            expect(analyzeByFile['fileA.ts'].length).toBe(3);
            expect(safeguardByFile['fileA.ts'].length).toBe(3);

            // --- File B: should have 2 chunks ---
            expect(analyzeByFile['fileB.ts'].length).toBe(2);
            expect(safeguardByFile['fileB.ts'].length).toBe(2);

            // Chunks for each file match between analyze and safeguard
            for (let i = 0; i < analyzeByFile['fileA.ts'].length; i++) {
                expect(analyzeByFile['fileA.ts'][i]).toBe(
                    safeguardByFile['fileA.ts'][i],
                );
            }
            for (let i = 0; i < analyzeByFile['fileB.ts'].length; i++) {
                expect(analyzeByFile['fileB.ts'][i]).toBe(
                    safeguardByFile['fileB.ts'][i],
                );
            }

            // No chunk from file A leaked into file B or vice versa
            for (const chunkA of analyzeByFile['fileA.ts']) {
                expect(analyzeByFile['fileB.ts']).not.toContain(chunkA);
            }
            for (const chunkB of analyzeByFile['fileB.ts']) {
                expect(analyzeByFile['fileA.ts']).not.toContain(chunkB);
            }

            // Each file's result has correct suggestions count
            expect(resultA.validSuggestionsToAnalyze).toHaveLength(3);
            expect(resultA.filename).toBe('fileA.ts');
            expect(resultB.validSuggestionsToAnalyze).toHaveLength(2);
            expect(resultB.filename).toBe('fileB.ts');

            // Suggestions from A don't appear in B's result
            const aSuggestionIds = resultA.validSuggestionsToAnalyze.map(
                (s: any) => s.id,
            );
            const bSuggestionIds = resultB.validSuggestionsToAnalyze.map(
                (s: any) => s.id,
            );
            for (const id of aSuggestionIds) {
                expect(bSuggestionIds).not.toContain(id);
            }
        });
    });
});
