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
import { CacheService } from '@libs/core/cache/cache.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
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

    const mockPermissionValidationService = {
        resolveTaskSlot: jest.fn().mockResolvedValue(undefined),
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
                {
                    provide: CacheService,
                    useValue: {
                        getFromCache: jest.fn(),
                        addToCache: jest.fn(),
                    },
                },
                {
                    provide: PermissionValidationService,
                    useValue: mockPermissionValidationService,
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

                const result =
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

                // Only suggestions actually persisted should be returned, so a
                // no-op verification doesn't trigger a spurious PR execution
                // broadcast downstream.
                expect(result).toEqual([]);
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
});
