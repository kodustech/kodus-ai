import { Test, TestingModule } from '@nestjs/testing';
import { AggregateResultsStage } from '@/code-review/pipeline/stages/aggregate-result.stage';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';

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

describe('AggregateResultsStage', () => {
    let stage: AggregateResultsStage;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) =>
        ({
            dryRun: { enabled: false },
            organizationAndTeamData: mockOrganizationAndTeamData as any,
            repository: { id: 'repo-1', name: 'test-repo' } as any,
            branch: 'main',
            pullRequest: {
                number: 123,
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
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            correlationId: 'test-correlation-id',
            ...overrides,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [AggregateResultsStage],
        }).compile();

        stage = module.get<AggregateResultsStage>(AggregateResultsStage);
    });

    describe('stage name', () => {
        it('should have correct stage name', () => {
            expect(stage.stageName).toBe('AggregateResultsStage');
        });
    });

    describe('aggregating file analysis results', () => {
        it('should aggregate valid suggestions from multiple file results', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [
                            {
                                id: 's1',
                                relevantFile: 'a.ts',
                                severity: 'high',
                            },
                            {
                                id: 's2',
                                relevantFile: 'a.ts',
                                severity: 'medium',
                            },
                        ],
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'a.ts' } as any,
                    },
                    {
                        validSuggestionsToAnalyze: [
                            {
                                id: 's3',
                                relevantFile: 'b.ts',
                                severity: 'critical',
                            },
                        ],
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'b.ts' } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions).toHaveLength(3);
            expect(result.validSuggestions.map((s) => s.id)).toContain('s1');
            expect(result.validSuggestions.map((s) => s.id)).toContain('s2');
            expect(result.validSuggestions.map((s) => s.id)).toContain('s3');
        });

        it('should aggregate discarded suggestions from multiple file results', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [],
                        discardedSuggestionsBySafeGuard: [
                            { id: 'd1', relevantFile: 'a.ts', severity: 'low' },
                        ],
                        file: { filename: 'a.ts' } as any,
                    },
                    {
                        validSuggestionsToAnalyze: [],
                        discardedSuggestionsBySafeGuard: [
                            { id: 'd2', relevantFile: 'b.ts', severity: 'low' },
                            { id: 'd3', relevantFile: 'b.ts', severity: 'low' },
                        ],
                        file: { filename: 'b.ts' } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.discardedSuggestions).toHaveLength(3);
        });

        it('should handle empty file analysis results', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [],
            });

            const result = await (stage as any).executeStage(context);

            // Should not crash and should preserve existing context
            expect(result).toBeDefined();
        });

        it('should handle undefined file analysis results', async () => {
            const context = createBaseContext({
                fileAnalysisResults: undefined,
            });

            const result = await (stage as any).executeStage(context);

            // Should not crash
            expect(result).toBeDefined();
        });

        it('should handle files with no suggestions', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [],
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'empty.ts' } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions).toHaveLength(0);
            expect(result.discardedSuggestions).toHaveLength(0);
        });
    });

    describe('aggregating PR analysis results', () => {
        it('should aggregate PR-level suggestions', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [],
                prAnalysisResults: {
                    validSuggestionsByPR: [
                        {
                            id: 'pr1',
                            suggestionContent: 'PR suggestion 1',
                        } as any,
                        {
                            id: 'pr2',
                            suggestionContent: 'PR suggestion 2',
                        } as any,
                    ],
                    validCrossFileSuggestions: [],
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestionsByPR).toHaveLength(2);
        });

        it('should aggregate cross-file suggestions', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [],
                prAnalysisResults: {
                    validSuggestionsByPR: [],
                    validCrossFileSuggestions: [
                        { id: 'cf1', relevantFile: 'cross.ts' } as any,
                    ],
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validCrossFileSuggestions).toHaveLength(1);
        });

        it('should handle empty PR analysis results', async () => {
            const context = createBaseContext({
                prAnalysisResults: {
                    validSuggestionsByPR: [],
                    validCrossFileSuggestions: [],
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
        });

        it('should handle undefined PR analysis results', async () => {
            const context = createBaseContext({
                prAnalysisResults: undefined,
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
        });
    });

    describe('combined aggregation', () => {
        it('should aggregate both file and PR level results', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [
                            { id: 's1', relevantFile: 'a.ts' },
                        ],
                        discardedSuggestionsBySafeGuard: [
                            { id: 'd1', relevantFile: 'a.ts' },
                        ],
                        file: { filename: 'a.ts' } as any,
                    },
                ],
                prAnalysisResults: {
                    validSuggestionsByPR: [{ id: 'pr1' } as any],
                    validCrossFileSuggestions: [{ id: 'cf1' } as any],
                },
            });

            const result = await (stage as any).executeStage(context);

            // File level
            expect(result.validSuggestions).toHaveLength(1);
            expect(result.discardedSuggestions).toHaveLength(1);

            // PR level
            expect(result.validSuggestionsByPR).toHaveLength(1);
            expect(result.validCrossFileSuggestions).toHaveLength(1);
        });

        it('should preserve suggestion properties during aggregation', async () => {
            const originalSuggestion = {
                id: 's1',
                relevantFile: 'test.ts',
                severity: 'critical',
                label: 'security',
                suggestionContent: 'Fix XSS vulnerability',
                existingCode: 'innerHTML = data',
                improvedCode: 'textContent = sanitize(data)',
            };

            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [originalSuggestion],
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'test.ts' } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            const aggregatedSuggestion = result.validSuggestions.find(
                (s) => s.id === 's1',
            );
            expect(aggregatedSuggestion).toEqual(originalSuggestion);
        });
    });

    describe('edge cases', () => {
        it('should handle very large number of suggestions', async () => {
            const suggestions = Array.from({ length: 100 }, (_, i) => ({
                id: `s${i}`,
                relevantFile: `file${i % 10}.ts`,
                severity: 'medium',
            }));

            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: suggestions,
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'large.ts' } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions).toHaveLength(100);
        });

        it('should handle suggestions with special characters', async () => {
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: [
                            {
                                id: 's1',
                                relevantFile: 'path/to/file with spaces.ts',
                                suggestionContent:
                                    'Handle \n newlines and "quotes"',
                            },
                        ],
                        discardedSuggestionsBySafeGuard: [],
                        file: {
                            filename: 'path/to/file with spaces.ts',
                        } as any,
                    },
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions).toHaveLength(1);
            expect(result.validSuggestions[0].suggestionContent).toContain(
                'newlines',
            );
        });

        it('should not mutate original context arrays', async () => {
            const originalSuggestions = [{ id: 's1', relevantFile: 'a.ts' }];
            const context = createBaseContext({
                fileAnalysisResults: [
                    {
                        validSuggestionsToAnalyze: originalSuggestions,
                        discardedSuggestionsBySafeGuard: [],
                        file: { filename: 'a.ts' } as any,
                    },
                ],
            });

            await (stage as any).executeStage(context);

            // Original array should remain unchanged (we're testing for potential mutations)
            expect(originalSuggestions).toHaveLength(1);
        });
    });
});
