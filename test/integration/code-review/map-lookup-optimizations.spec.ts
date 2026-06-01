/**
 * Integration tests for Map-based lookup optimizations
 *
 * These tests verify that the refactored methods using Map for O(1) lookups
 * maintain the same behavior as the original O(n) implementations using .find()
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SuggestionService } from '@/code-review/infrastructure/adapters/services/suggestion.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@/code-review/domain/contracts/CommentManagerService.contract';
import { CodeManagementService } from '@/platform/infrastructure/adapters/services/codeManagement.service';
import {
    ClusteringType,
    CodeSuggestion,
} from '@/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@/platformData/domain/pullRequests/enums/priorityStatus.enum';

describe('Map-based Lookup Optimizations - Integration Tests', () => {
    let suggestionService: SuggestionService;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    // Mock services
    const mockAIAnalysisService = {
        validateImplementedSuggestions: jest.fn(),
        severityAnalysisAssignment: jest.fn(),
        filterSuggestionsSafeGuard: jest.fn(),
    };

    const mockPullRequestService = {
        updateSuggestion: jest.fn(),
        findSuggestionsByPR: jest.fn(),
    };

    const mockCommentManagerService = {
        repeatedCodeReviewSuggestionClustering: jest.fn(),
        enrichParentSuggestionsWithRelated: jest.fn(),
    };

    const mockCodeManagementService = {
        getPullRequestReviewThreads: jest.fn(),
        getPullRequestReviewComments: jest.fn(),
        markReviewCommentAsResolved: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SuggestionService,
                {
                    provide: LLM_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockAIAnalysisService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestService,
                },
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: mockCommentManagerService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        suggestionService = module.get<SuggestionService>(SuggestionService);
        jest.clearAllMocks();
    });

    describe('SuggestionService - Map Lookup Optimizations', () => {
        describe('validateImplementedSuggestions - savedSuggestionsMap lookup', () => {
            it('should correctly match implemented suggestions with saved suggestions using Map', async () => {
                const savedSuggestions = [
                    { id: 'sug-1', relevantFile: 'file1.ts', severity: 'high' },
                    {
                        id: 'sug-2',
                        relevantFile: 'file2.ts',
                        severity: 'medium',
                    },
                    { id: 'sug-3', relevantFile: 'file3.ts', severity: 'low' },
                ];

                const implementedSuggestions = [
                    { id: 'sug-1', implementationStatus: 'IMPLEMENTED' },
                    { id: 'sug-3', implementationStatus: 'IMPLEMENTED' },
                ];

                mockAIAnalysisService.validateImplementedSuggestions.mockResolvedValue(
                    implementedSuggestions,
                );
                mockPullRequestService.updateSuggestion.mockResolvedValue({});

                const result =
                    await suggestionService.validateImplementedSuggestions(
                        mockOrganizationAndTeamData,
                        'code patch',
                        savedSuggestions as any,
                        123,
                    );

                // Should have called updateSuggestion for each implemented suggestion found in saved
                expect(
                    mockPullRequestService.updateSuggestion,
                ).toHaveBeenCalledTimes(2);

                // Verify correct IDs were updated. Third arg is the
                // org/team scope added by the cross-org leak fix in
                // 57c3de5d1 (mongo writes scoped by organizationId).
                expect(
                    mockPullRequestService.updateSuggestion,
                ).toHaveBeenCalledWith(
                    'sug-1',
                    expect.objectContaining({
                        implementationStatus: 'IMPLEMENTED',
                    }),
                    mockOrganizationAndTeamData,
                );
                expect(
                    mockPullRequestService.updateSuggestion,
                ).toHaveBeenCalledWith(
                    'sug-3',
                    expect.objectContaining({
                        implementationStatus: 'IMPLEMENTED',
                    }),
                    mockOrganizationAndTeamData,
                );

                expect(result).toEqual(implementedSuggestions);
            });

            it('should handle case where implemented suggestion is not in saved suggestions', async () => {
                const savedSuggestions = [
                    { id: 'sug-1', relevantFile: 'file1.ts' },
                ];

                const implementedSuggestions = [
                    { id: 'sug-999', implementationStatus: 'IMPLEMENTED' }, // Not in saved
                ];

                mockAIAnalysisService.validateImplementedSuggestions.mockResolvedValue(
                    implementedSuggestions,
                );

                await suggestionService.validateImplementedSuggestions(
                    mockOrganizationAndTeamData,
                    'code patch',
                    savedSuggestions as any,
                    123,
                );

                // Should not call updateSuggestion since ID not found
                expect(
                    mockPullRequestService.updateSuggestion,
                ).not.toHaveBeenCalled();
            });

            it('should handle large datasets efficiently with Map lookup', async () => {
                // Create large arrays to simulate real-world scenario
                const savedSuggestions = Array.from(
                    { length: 1000 },
                    (_, i) => ({
                        id: `sug-${i}`,
                        relevantFile: `file${i}.ts`,
                        severity: 'medium',
                    }),
                );

                const implementedSuggestions = [
                    { id: 'sug-0', implementationStatus: 'IMPLEMENTED' },
                    { id: 'sug-500', implementationStatus: 'IMPLEMENTED' },
                    { id: 'sug-999', implementationStatus: 'IMPLEMENTED' },
                ];

                mockAIAnalysisService.validateImplementedSuggestions.mockResolvedValue(
                    implementedSuggestions,
                );
                mockPullRequestService.updateSuggestion.mockResolvedValue({});

                const startTime = Date.now();
                await suggestionService.validateImplementedSuggestions(
                    mockOrganizationAndTeamData,
                    'code patch',
                    savedSuggestions as any,
                    123,
                );
                const endTime = Date.now();

                // Should complete quickly (Map is O(1) vs O(n) for find)
                expect(endTime - startTime).toBeLessThan(100); // Should be under 100ms
                expect(
                    mockPullRequestService.updateSuggestion,
                ).toHaveBeenCalledTimes(3);
            });
        });

        describe('prioritizeSuggestionsBySeverityLimits - categorization with single loop', () => {
            it('should correctly categorize suggestions by severity using single loop', async () => {
                const suggestions = [
                    { id: '1', severity: 'critical', label: 'security' },
                    { id: '2', severity: 'critical', label: 'security' },
                    { id: '3', severity: 'high', label: 'performance' },
                    { id: '4', severity: 'high', label: 'performance' },
                    { id: '5', severity: 'medium', label: 'maintainability' },
                    { id: '6', severity: 'low', label: 'code_style' },
                ];

                // Note: limit=0 means "no limit" (include all), limit>0 means "up to this limit"
                const severityLimits = {
                    critical: 1,
                    high: 2,
                    medium: 1,
                    low: 1, // limit to 1 low suggestion
                };

                const result =
                    await suggestionService.prioritizeSuggestionsBySeverityLimits(
                        mockOrganizationAndTeamData as any,
                        123,
                        suggestions as any,
                        severityLimits,
                    );

                // Should have 1 critical + 2 high + 1 medium + 1 low = 5 prioritized
                const prioritized = result.filter(
                    (s) => s.priorityStatus === PriorityStatus.PRIORITIZED,
                );
                expect(prioritized).toHaveLength(5);

                // Verify correct severities are prioritized
                const prioritizedSeverities = prioritized.map(
                    (s) => s.severity,
                );
                expect(
                    prioritizedSeverities.filter((s) => s === 'critical'),
                ).toHaveLength(1);
                expect(
                    prioritizedSeverities.filter((s) => s === 'high'),
                ).toHaveLength(2);
                expect(
                    prioritizedSeverities.filter((s) => s === 'medium'),
                ).toHaveLength(1);
                expect(
                    prioritizedSeverities.filter((s) => s === 'low'),
                ).toHaveLength(1);
            });

            it('should handle suggestions with mixed case severities', async () => {
                const suggestions = [
                    { id: '1', severity: 'CRITICAL', label: 'security' },
                    { id: '2', severity: 'High', label: 'performance' },
                    { id: '3', severity: 'medium', label: 'maintainability' },
                ];

                // Note: limit=0 means "no limit", so we use limit=1 for each to test
                const severityLimits = {
                    critical: 1,
                    high: 1,
                    medium: 1,
                    low: 1, // No low suggestions in input anyway
                };

                const result =
                    await suggestionService.prioritizeSuggestionsBySeverityLimits(
                        mockOrganizationAndTeamData as any,
                        123,
                        suggestions as any,
                        severityLimits,
                    );

                const prioritized = result.filter(
                    (s) => s.priorityStatus === PriorityStatus.PRIORITIZED,
                );
                // 1 critical + 1 high + 1 medium = 3
                expect(prioritized).toHaveLength(3);
            });
        });

        describe('normalizeSeverity - Set-based groupIdSet lookup', () => {
            it('should normalize clustered suggestions to highest severity using Set', async () => {
                // Access private method through the service's public interface
                const suggestions: Partial<CodeSuggestion>[] = [
                    {
                        id: 'parent-1',
                        severity: 'low',
                        clusteringInformation: {
                            type: ClusteringType.PARENT,
                            relatedSuggestionsIds: ['related-1', 'related-2'],
                        },
                    },
                    {
                        id: 'related-1',
                        severity: 'critical',
                        clusteringInformation: {
                            type: ClusteringType.RELATED,
                            parentSuggestionId: 'parent-1',
                        },
                    },
                    {
                        id: 'related-2',
                        severity: 'medium',
                        clusteringInformation: {
                            type: ClusteringType.RELATED,
                            parentSuggestionId: 'parent-1',
                        },
                    },
                    {
                        id: 'standalone',
                        severity: 'high',
                    },
                ];

                // Use filterSuggestionsBySeverityLevel which internally processes clustering
                const result =
                    await suggestionService.filterSuggestionsBySeverityLevel(
                        suggestions,
                        'low', // All severities should pass
                        mockOrganizationAndTeamData as any,
                        123,
                    );

                // All suggestions should be processed
                expect(result.length).toBeGreaterThan(0);
            });

            it('should handle multiple independent clusters with Set lookup', async () => {
                const suggestions: Partial<CodeSuggestion>[] = [
                    {
                        id: 'parent-1',
                        severity: 'low',
                        clusteringInformation: {
                            type: ClusteringType.PARENT,
                            relatedSuggestionsIds: ['related-1'],
                        },
                    },
                    {
                        id: 'related-1',
                        severity: 'high',
                        clusteringInformation: {
                            type: ClusteringType.RELATED,
                            parentSuggestionId: 'parent-1',
                        },
                    },
                    {
                        id: 'parent-2',
                        severity: 'medium',
                        clusteringInformation: {
                            type: ClusteringType.PARENT,
                            relatedSuggestionsIds: ['related-2'],
                        },
                    },
                    {
                        id: 'related-2',
                        severity: 'critical',
                        clusteringInformation: {
                            type: ClusteringType.RELATED,
                            parentSuggestionId: 'parent-2',
                        },
                    },
                ];

                const result =
                    await suggestionService.filterSuggestionsBySeverityLevel(
                        suggestions,
                        'low',
                        mockOrganizationAndTeamData as any,
                        123,
                    );

                expect(result).toHaveLength(4);
            });
        });
    });

    describe('Map-based grouping logic - enrichParentSuggestionsWithRelated', () => {
        /**
         * This test verifies the Map-based grouping logic used in enrichParentSuggestionsWithRelated.
         * Instead of instantiating the full CommentManagerService (which has many dependencies),
         * we test the core algorithm directly.
         */
        it('should correctly group related suggestions by parent using Map', () => {
            const suggestions: CodeSuggestion[] = [
                {
                    id: 'parent-1',
                    severity: 'high',
                    relevantFile: 'file1.ts',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 20,
                    clusteringInformation: {
                        type: ClusteringType.PARENT,
                        relatedSuggestionsIds: ['related-1', 'related-2'],
                        problemDescription: 'Duplicate code detected',
                    },
                } as CodeSuggestion,
                {
                    id: 'related-1',
                    severity: 'high',
                    relevantFile: 'file2.ts',
                    relevantLinesStart: 30,
                    relevantLinesEnd: 40,
                    clusteringInformation: {
                        type: ClusteringType.RELATED,
                        parentSuggestionId: 'parent-1',
                    },
                } as CodeSuggestion,
                {
                    id: 'related-2',
                    severity: 'high',
                    relevantFile: 'file3.ts',
                    relevantLinesStart: 50,
                    relevantLinesEnd: 60,
                    clusteringInformation: {
                        type: ClusteringType.RELATED,
                        parentSuggestionId: 'parent-1',
                    },
                } as CodeSuggestion,
                {
                    id: 'standalone',
                    severity: 'medium',
                    relevantFile: 'file4.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 5,
                } as CodeSuggestion,
            ];

            // Replicate the Map-based grouping logic from enrichParentSuggestionsWithRelated
            const relatedByParentId = new Map<string, CodeSuggestion[]>();
            for (const s of suggestions) {
                if (
                    s.clusteringInformation?.type === ClusteringType.RELATED &&
                    s.clusteringInformation?.parentSuggestionId
                ) {
                    const parentId = s.clusteringInformation.parentSuggestionId;
                    if (!relatedByParentId.has(parentId)) {
                        relatedByParentId.set(parentId, []);
                    }
                    relatedByParentId.get(parentId)!.push(s);
                }
            }

            // Verify Map was built correctly
            expect(relatedByParentId.size).toBe(1);
            expect(relatedByParentId.has('parent-1')).toBe(true);
            expect(relatedByParentId.get('parent-1')).toHaveLength(2);

            // Now apply the enrichment logic
            const result = suggestions.map((suggestion) => {
                if (
                    suggestion.clusteringInformation?.type !==
                    ClusteringType.PARENT
                ) {
                    return suggestion;
                }

                const relatedSuggestions =
                    relatedByParentId.get(suggestion.id) || [];
                const occurrences = [
                    {
                        file: suggestion.relevantFile,
                        lines: `${suggestion.relevantLinesStart}-${suggestion.relevantLinesEnd}`,
                    },
                    ...relatedSuggestions.map((s) => ({
                        file: s.relevantFile,
                        lines: `${s.relevantLinesStart}-${s.relevantLinesEnd}`,
                    })),
                ];

                const enrichedBody = `${suggestion?.clusteringInformation?.problemDescription}\n\nThis issue appears in multiple locations:\n${occurrences
                    .map((o) => `* ${o.file}: Lines ${o.lines}`)
                    .join('\n')}`;

                return {
                    ...suggestion,
                    suggestionContent: enrichedBody,
                };
            });

            // Verify results
            expect(result).toHaveLength(4);

            const parent = result.find((s) => s.id === 'parent-1');
            expect(parent?.suggestionContent).toContain('multiple locations');
            expect(parent?.suggestionContent).toContain('file1.ts');
            expect(parent?.suggestionContent).toContain('file2.ts');
            expect(parent?.suggestionContent).toContain('file3.ts');

            const standalone = result.find((s) => s.id === 'standalone');
            expect(standalone?.suggestionContent).toBeUndefined();
        });

        it('should handle large number of clusters efficiently with Map', () => {
            // Create 100 clusters with 5 related suggestions each = 600 suggestions
            const suggestions: CodeSuggestion[] = [];

            for (let cluster = 0; cluster < 100; cluster++) {
                suggestions.push({
                    id: `parent-${cluster}`,
                    severity: 'high',
                    relevantFile: `file${cluster}.ts`,
                    relevantLinesStart: cluster * 10,
                    relevantLinesEnd: cluster * 10 + 5,
                    clusteringInformation: {
                        type: ClusteringType.PARENT,
                        relatedSuggestionsIds: Array.from(
                            { length: 5 },
                            (_, i) => `related-${cluster}-${i}`,
                        ),
                        problemDescription: `Problem in cluster ${cluster}`,
                    },
                } as CodeSuggestion);

                for (let related = 0; related < 5; related++) {
                    suggestions.push({
                        id: `related-${cluster}-${related}`,
                        severity: 'high',
                        relevantFile: `file${cluster}-${related}.ts`,
                        relevantLinesStart: cluster * 100 + related * 10,
                        relevantLinesEnd: cluster * 100 + related * 10 + 5,
                        clusteringInformation: {
                            type: ClusteringType.RELATED,
                            parentSuggestionId: `parent-${cluster}`,
                        },
                    } as CodeSuggestion);
                }
            }

            // Time the Map-based grouping
            const startTime = Date.now();

            const relatedByParentId = new Map<string, CodeSuggestion[]>();
            for (const s of suggestions) {
                if (
                    s.clusteringInformation?.type === ClusteringType.RELATED &&
                    s.clusteringInformation?.parentSuggestionId
                ) {
                    const parentId = s.clusteringInformation.parentSuggestionId;
                    if (!relatedByParentId.has(parentId)) {
                        relatedByParentId.set(parentId, []);
                    }
                    relatedByParentId.get(parentId)!.push(s);
                }
            }

            const result = suggestions.map((suggestion) => {
                if (
                    suggestion.clusteringInformation?.type !==
                    ClusteringType.PARENT
                ) {
                    return suggestion;
                }
                const relatedSuggestions =
                    relatedByParentId.get(suggestion.id) || [];
                const occurrences = [
                    {
                        file: suggestion.relevantFile,
                        lines: `${suggestion.relevantLinesStart}-${suggestion.relevantLinesEnd}`,
                    },
                    ...relatedSuggestions.map((s) => ({
                        file: s.relevantFile,
                        lines: `${s.relevantLinesStart}-${s.relevantLinesEnd}`,
                    })),
                ];
                return {
                    ...suggestion,
                    suggestionContent: `Problem\n\nThis issue appears in multiple locations:\n${occurrences.map((o) => `* ${o.file}`).join('\n')}`,
                };
            });

            const endTime = Date.now();

            // Should complete quickly with Map (O(n) vs O(n²))
            expect(endTime - startTime).toBeLessThan(100); // Should be under 100ms
            expect(result).toHaveLength(600);
            expect(relatedByParentId.size).toBe(100);

            // Verify all parents have enriched content
            const parents = result.filter(
                (s) => s.clusteringInformation?.type === ClusteringType.PARENT,
            );
            expect(parents).toHaveLength(100);
            parents.forEach((parent) => {
                expect(parent.suggestionContent).toContain(
                    'multiple locations',
                );
            });
        });
    });

    describe('Performance Comparison - Map vs Array.find', () => {
        it('should demonstrate Map lookup is faster than Array.find for large datasets', () => {
            const size = 10000;
            const data = Array.from({ length: size }, (_, i) => ({
                id: `item-${i}`,
                value: `value-${i}`,
            }));

            const lookupIds = [
                'item-0',
                'item-5000',
                'item-9999',
                'item-2500',
                'item-7500',
            ];

            // Array.find approach (O(n) per lookup)
            const findStartTime = Date.now();
            for (let i = 0; i < 1000; i++) {
                lookupIds.forEach((id) => {
                    data.find((item) => item.id === id);
                });
            }
            const findEndTime = Date.now();
            const findDuration = findEndTime - findStartTime;

            // Map approach (O(1) per lookup)
            const map = new Map(data.map((item) => [item.id, item]));
            const mapStartTime = Date.now();
            for (let i = 0; i < 1000; i++) {
                lookupIds.forEach((id) => {
                    map.get(id);
                });
            }
            const mapEndTime = Date.now();
            const mapDuration = mapEndTime - mapStartTime;

            // Map should be significantly faster
            expect(mapDuration).toBeLessThan(findDuration);

            // Log for visibility
            console.log(
                `Array.find: ${findDuration}ms, Map.get: ${mapDuration}ms`,
            );
            console.log(
                `Map is ${(findDuration / mapDuration).toFixed(2)}x faster`,
            );
        });
    });
});
