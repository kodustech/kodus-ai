import { Injectable, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ISuggestionService } from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import {
    CodeSuggestion,
    SuggestionControlConfig,
    LimitationType,
    GroupingModeSuggestions,
    ReviewOptions,
    ReviewModeResponse,
    ImplementedSuggestionsToAnalyze,
    ClusteringType,
    CodeReviewConfig,
    CommentResult,
} from '@/config/types/general/codeReview.type';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { extractLinesFromDiffHunk } from '@/shared/utils/patch';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '../codeBase/llmAnalysis.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { PinoLoggerService } from '../logger/pino.service';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';

@Injectable()
export class SuggestionService implements ISuggestionService {
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        private readonly logger: PinoLoggerService,
    ) {}

    /**
     * Removes suggestions related to files that already have saved suggestions
     */
    public async removeSuggestionsRelatedToSavedFiles(
        organizationAndTeamData,
        prNumber: string,
        savedSuggestions,
        newSuggestions,
    ): Promise<any> {
        try {
            const filesWithSavedSuggestions = new Set(
                savedSuggestions.map((s) => s.relevantFile),
            );

            return newSuggestions.filter(
                (suggestion) =>
                    !filesWithSavedSuggestions.has(suggestion.relevantFile),
            );
        } catch (error) {
            this.logger.log({
                message: `Error when trying to remove repeated suggestions for PR#${prNumber}`,
                error: error,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber: prNumber,
                },
            });

            return newSuggestions;
        }
    }

    /**
     * Prepares suggestion properties for validation
     */
    public filterSuggestionProperties(
        suggestions: Partial<CodeSuggestion>[],
    ): ImplementedSuggestionsToAnalyze[] {
        return suggestions.map((suggestion) => ({
            id: suggestion.id,
            relevantFile: suggestion.relevantFile,
            language: suggestion.language,
            improvedCode: suggestion.improvedCode,
            existingCode: suggestion.existingCode,
        }));
    }

    /**
     * Validates if suggestions have been implemented by analyzing code patches
     */
    public async validateImplementedSuggestions(
        organizationAndTeamData,
        codePatch,
        savedSuggestions: Partial<CodeSuggestion>[],
        prNumber?: number,
    ) {
        try {
            const filteredSuggestions =
                this.filterSuggestionProperties(savedSuggestions);

            const implementedSuggestions =
                await this.aiAnalysisService.validateImplementedSuggestions(
                    organizationAndTeamData,
                    prNumber,
                    LLMModelProvider.DEEPSEEK_V3,
                    codePatch,
                    filteredSuggestions,
                );

            if (implementedSuggestions && implementedSuggestions?.length > 0) {
                for (const suggestion of implementedSuggestions) {
                    const savedSuggestion = savedSuggestions?.find(
                        (s) => s.id === suggestion.id,
                    );

                    if (savedSuggestion) {
                        await this.pullRequestService.updateSuggestion(
                            savedSuggestion.id,
                            {
                                implementationStatus:
                                    suggestion.implementationStatus,
                                updatedAt: new Date().toISOString(),
                            },
                        );
                    }
                }
            }

            return implementedSuggestions;
        } catch (error) {
            this.logger.log({
                message: `Error when trying to validate implemented suggestions for PR#${prNumber}`,
                error: error,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
        }
    }

    /**
     * Normalizes label strings for consistent matching
     */
    public normalizeLabel(label: string): string {
        return (label || '').toLowerCase().replace(/\s+/g, '_');
    }

    /**
     * Filters suggestions based on user-selected review options
     */
    public filterCodeSuggestionsByReviewOptions(config, codeReviewComments) {
        const filteredSuggestions = codeReviewComments?.codeSuggestions?.filter(
            (suggestion) => {
                const normalizedLabel = this.normalizeLabel(suggestion.label);
                return config?.[normalizedLabel] === true;
            },
        );

        return {
            overallSummary: codeReviewComments.overallSummary,
            codeSuggestions: filteredSuggestions,
        };
    }

    /**
     * Filters suggestions to only include those that are relevant to changed lines in the diff
     */
    public filterSuggestionsCodeDiff(
        patchWithLinesStr: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ) {
        const modifiedRanges = extractLinesFromDiffHunk(patchWithLinesStr);

        return codeSuggestions?.filter((suggestion) => {
            return modifiedRanges.some(
                (range) =>
                    // The suggestion is completely within the range
                    (suggestion?.relevantLinesStart >= range.start &&
                        suggestion?.relevantLinesStart <= range.end) ||
                    // The start of the suggestion is within the range
                    (suggestion?.relevantLinesStart >= range.start &&
                        suggestion?.relevantLinesStart <= range.end) ||
                    // The end of the suggestion is within the range
                    (suggestion?.relevantLinesEnd >= range.start &&
                        suggestion?.relevantLinesEnd <= range.end) ||
                    // The range is completely within the suggestion
                    (suggestion?.relevantLinesStart <= range.start &&
                        suggestion?.relevantLinesEnd >= range.end),
            );
        });
    }

    /**
     * Applies a safeguard filter using AI to verify suggestions are valid
     */
    public async filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
    ) {
        if (!suggestions?.length) {
            return suggestions;
        }

        return this.aiAnalysisService.filterSuggestionsSafeGuard(
            organizationAndTeamData,
            prNumber,
            file,
            codeDiff,
            suggestions,
            languageResultPrompt,
            reviewMode,
        );
    }

    /**
     * Identifies discarded suggestions between two sets
     */
    public getDiscardedSuggestions(
        allSuggestions: Partial<CodeSuggestion>[],
        filteredSuggestions: Partial<CodeSuggestion>[],
        discardReason: PriorityStatus,
    ): Partial<CodeSuggestion>[] {
        return allSuggestions
            ?.filter(
                (suggestion) =>
                    !!suggestion.id &&
                    !filteredSuggestions.some(
                        (filtered) =>
                            filtered.id && filtered.id === suggestion.id,
                    ),
            )
            ?.map((suggestion) => ({
                ...suggestion,
                deliveryStatus: DeliveryStatus.NOT_SENT,
                priorityStatus: discardReason,
            }));
    }

    /**
     * Gets suggestions discarded during quantity filtering
     */
    public getDiscardedByQuantity(
        beforeQuantityFilter: Partial<CodeSuggestion>[],
        afterQuantityFilter: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[] {
        return this.getDiscardedSuggestions(
            beforeQuantityFilter,
            afterQuantityFilter,
            PriorityStatus.DISCARDED_BY_QUANTITY,
        );
    }

    /**
     * Prioritizes suggestions based on quantity limits
     */
    public async prioritizeByQuantity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        limitationType: LimitationType,
        maxSuggestions: number,
        groupingMode: GroupingModeSuggestions,
        prioritizedBySeverity: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        let relatedSuggestionsClustered: Partial<CodeSuggestion>[] = [];

        if (
            groupingMode === GroupingModeSuggestions.SMART ||
            groupingMode === GroupingModeSuggestions.FULL
        ) {
            relatedSuggestionsClustered = prioritizedBySeverity.filter(
                (s) => s.clusteringInformation?.type === ClusteringType.RELATED,
            );

            prioritizedBySeverity = prioritizedBySeverity.filter(
                (s) => s.clusteringInformation?.type !== ClusteringType.RELATED,
            );
        }

        const prioritizedByQuantity =
            !limitationType || limitationType === LimitationType.FILE
                ? await this.prioritizeSuggestionsByFile(
                      organizationAndTeamData,
                      prNumber,
                      prioritizedBySeverity,
                      maxSuggestions,
                  )
                : await this.prioritizeSuggestionsByPR(
                      organizationAndTeamData,
                      prNumber,
                      prioritizedBySeverity,
                      maxSuggestions,
                  );

        if (relatedSuggestionsClustered?.length > 0) {
            // Adds related suggestions if the parent was prioritized
            return await this.addRelatedSuggestionsFromPrioritizedParents(
                relatedSuggestionsClustered,
                prioritizedByQuantity,
            );
        }

        return prioritizedByQuantity;
    }

    /**
     * Adds related suggestions when parent suggestions are prioritized
     */
    private async addRelatedSuggestionsFromPrioritizedParents(
        suggestionsClustered: Partial<CodeSuggestion>[],
        prioritizedByQuantity: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const prioritizedIds = new Set(prioritizedByQuantity.map((s) => s.id));

        const relatedToPrioritized = suggestionsClustered
            .filter(
                (suggestion) =>
                    suggestion.clusteringInformation?.type ===
                        ClusteringType.RELATED &&
                    suggestion.clusteringInformation?.parentSuggestionId &&
                    prioritizedIds.has(
                        suggestion.clusteringInformation.parentSuggestionId,
                    ),
            )
            .map((suggestion) => ({
                ...suggestion,
                priorityStatus: PriorityStatus.PRIORITIZED_BY_CLUSTERING,
            }));

        return [...prioritizedByQuantity, ...relatedToPrioritized];
    }

    /**
     * Prioritizes suggestions based on PR-specific logic
     */
    public async prioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: any[],
    ): Promise<{
        prioritizedSuggestions: any[];
        discardedSuggestionsBySeverityOrQuantity: any[];
    }> {
        const {
            groupingMode,
            maxSuggestions,
            limitationType,
            severityLevelFilter,
        } = suggestionControl;

        let refinedSuggestions = suggestions;

        if (
            groupingMode === GroupingModeSuggestions.SMART ||
            groupingMode === GroupingModeSuggestions.FULL
        ) {
            const suggestionsClustered =
                await this.commentManagerService.repeatedCodeReviewSuggestionClustering(
                    organizationAndTeamData,
                    prNumber,
                    LLMModelProvider.DEEPSEEK_V3,
                    suggestions,
                );

            refinedSuggestions =
                await this.normalizeSeverity(suggestionsClustered);
        }

        const { prioritizedBySeverity, discardedBySeverity } =
            await this.processSeverityFilter(
                refinedSuggestions,
                severityLevelFilter,
                organizationAndTeamData,
                prNumber,
            );

        if (!prioritizedBySeverity.length) {
            return {
                prioritizedSuggestions: [],
                discardedSuggestionsBySeverityOrQuantity: discardedBySeverity,
            };
        }

        const prioritizedByQuantity = await this.prioritizeByQuantity(
            organizationAndTeamData,
            prNumber,
            limitationType,
            maxSuggestions,
            groupingMode,
            prioritizedBySeverity,
        );

        const discardedByQuantity = this.getDiscardedByQuantity(
            prioritizedBySeverity,
            prioritizedByQuantity,
        );

        return {
            prioritizedSuggestions: prioritizedByQuantity,
            discardedSuggestionsBySeverityOrQuantity: [
                ...discardedBySeverity,
                ...discardedByQuantity,
            ],
        };
    }

    /**
     * Filters suggestions based on severity level
     */
    public async filterSuggestionsBySeverityLevel(
        suggestions: any[],
        severityLevelFilter: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<any[]> {
        try {
            this.logger.log({
                message: `Prioritizing suggestions by severity level for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    severityLevelFilter,
                    suggestionsCount: suggestions?.length,
                    organizationAndTeamData,
                    prNumber,
                },
            });

            const severityLevels = {
                critical: ['critical'],
                high: ['critical', 'high'],
                medium: ['critical', 'high', 'medium'],
                low: ['critical', 'high', 'medium', 'low'],
            };

            const acceptedSeverities =
                severityLevels[severityLevelFilter] || [];

            return suggestions.map((suggestion) => ({
                ...suggestion,
                priorityStatus: acceptedSeverities.includes(
                    suggestion?.severity?.toLowerCase(),
                )
                    ? PriorityStatus.PRIORITIZED
                    : PriorityStatus.DISCARDED_BY_SEVERITY,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            }));
        } catch (error) {
            this.logger.log({
                message: `Failed to prioritize suggestions by severity level for PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    severityLevelFilter,
                    suggestionsCount: suggestions?.length,
                    organizationAndTeamData,
                    prNumber,
                },
            });

            return suggestions;
        }
    }

    /**
     * Processes suggestions by applying severity filter
     */
    public async processSeverityFilter(
        suggestions: any[],
        severityLevelFilter: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<{ prioritizedBySeverity: any[]; discardedBySeverity: any[] }> {
        try {
            const filtered = await this.filterSuggestionsBySeverityLevel(
                suggestions,
                severityLevelFilter,
                organizationAndTeamData,
                prNumber,
            );

            return {
                prioritizedBySeverity: filtered.filter(
                    (s) => s.priorityStatus === PriorityStatus.PRIORITIZED,
                ),
                discardedBySeverity: filtered.filter(
                    (s) =>
                        s.priorityStatus ===
                        PriorityStatus.DISCARDED_BY_SEVERITY,
                ),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing severity filter',
                error,
                context: SuggestionService.name,
                metadata: { prNumber, organizationAndTeamData },
            });
            return {
                prioritizedBySeverity: suggestions,
                discardedBySeverity: [],
            };
        }
    }

    /**
     * Sorts suggestions by file path and severity
     */
    public sortSuggestionsByFilePathAndSeverity(
        suggestions: CodeSuggestion[],
        groupingMode: GroupingModeSuggestions,
    ) {
        let sortedParentSuggestions: any[] = [];

        if (
            groupingMode === GroupingModeSuggestions.FULL ||
            groupingMode === GroupingModeSuggestions.SMART
        ) {
            // Separate suggestions of type parent and non-parent
            const parentSuggestions = suggestions.filter(
                (s) => s.clusteringInformation?.type === ClusteringType.PARENT,
            );

            // Sort suggestions of type parent by severity
            sortedParentSuggestions = [...parentSuggestions].sort((a, b) => {
                const severityOrder = {
                    [SeverityLevel.CRITICAL]: 4,
                    [SeverityLevel.HIGH]: 3,
                    [SeverityLevel.MEDIUM]: 2,
                    [SeverityLevel.LOW]: 1,
                };
                return severityOrder[b.severity] - severityOrder[a.severity];
            });
        }

        const nonParentSuggestions = suggestions.filter(
            (s) => s.clusteringInformation?.type !== ClusteringType.PARENT,
        );

        // Sort non-parent suggestions as before
        const sortedNonParentSuggestions = [...nonParentSuggestions].sort(
            (a, b) => {
                if (a.relevantFile < b.relevantFile) return -1;
                if (a.relevantFile > b.relevantFile) return 1;

                const severityOrder = {
                    [SeverityLevel.LOW]: 1,
                    [SeverityLevel.MEDIUM]: 2,
                    [SeverityLevel.HIGH]: 3,
                    [SeverityLevel.CRITICAL]: 4,
                };

                return severityOrder[b.severity] - severityOrder[a.severity];
            },
        );

        // Return the combination of sorted suggestions
        return [...sortedParentSuggestions, ...sortedNonParentSuggestions];
    }

    /**
     * Sorts suggestions by priority score
     */
    public sortSuggestionsByPriority(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: any[],
    ): any[] {
        this.logger.log({
            message: `Suggestions to be sorted by priority for PR#${prNumber}`,
            context: SuggestionService.name,
            metadata: {
                suggestionsIdsAndRankScores: suggestions?.map((suggestion) => ({
                    id: suggestion?.id,
                    rankScore: suggestion?.rankScore,
                    relevantFile: suggestion?.relevantFile,
                })),
                prNumber: prNumber,
                organizationAndTeamData,
            },
        });

        const categoryPriority = {
            kody_rules: 1,
            breaking_changes: 2,
            security: 3,
            potential_issues: 4,
            error_handling: 5,
            performance_and_optimization: 6,
            maintainability: 7,
            refactoring: 8,
            code_style: 9,
            documentation_and_comments: 10,
        };

        const sortedSuggestions = [...suggestions].sort((a, b) => {
            if (a.rankScore !== b.rankScore) {
                return b.rankScore - a.rankScore;
            }
            return (
                (categoryPriority[a.label] || 999) -
                (categoryPriority[b.label] || 999)
            );
        });

        this.logger.log({
            message: `Suggestions sorted by priority for PR#${prNumber}`,
            context: SuggestionService.name,
            metadata: {
                suggestionsIdsAndRankScores: sortedSuggestions?.map(
                    (suggestion) => ({
                        id: suggestion?.id,
                        rankScore: suggestion?.rankScore,
                        relevantFile: suggestion?.relevantFile,
                    }),
                ),
                prNumber: prNumber,
                organizationAndTeamData,
            },
        });

        return sortedSuggestions;
    }

    public async prioritizeSuggestionsByFile(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: any[],
        limitPerFile: number,
    ): Promise<any[]> {
        try {
            this.logger.log({
                message: `Prioritizing suggestions by file for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    suggestionsCount: suggestions?.length,
                    suggestionsIds: suggestions?.map(
                        (suggestion) => suggestion.id,
                    ),
                    limitPerFile: limitPerFile,
                    filepaths: suggestions?.map(
                        (suggestion) => suggestion.relevantFile,
                    ),
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });

            const fileGroups = new Map<string, any[]>();
            suggestions.forEach((suggestion) => {
                const file = suggestion.relevantFile;
                if (!fileGroups.has(file)) {
                    fileGroups.set(file, []);
                }
                fileGroups.get(file).push(suggestion);
            });

            const prioritizedSuggestions: any[] = [];
            fileGroups.forEach((fileSuggestions) => {
                const sortedSuggestions = this.sortSuggestionsByPriority(
                    organizationAndTeamData,
                    prNumber,
                    fileSuggestions,
                );
                prioritizedSuggestions.push(
                    ...sortedSuggestions.slice(0, limitPerFile),
                );
            });

            const prioritizedSuggestionsWithStatus = prioritizedSuggestions.map(
                (suggestion) => ({
                    ...suggestion,
                    priorityStatus: PriorityStatus.PRIORITIZED,
                }),
            );

            this.logger.log({
                message: `Suggestions prioritized by file for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    prioritizedSuggestionsCount:
                        prioritizedSuggestionsWithStatus?.length,
                    prioritizedSuggestionsIds:
                        prioritizedSuggestionsWithStatus?.map(
                            (suggestion) => suggestion.id,
                        ),
                    limitPerFile: limitPerFile,
                    filepaths: prioritizedSuggestionsWithStatus?.map(
                        (suggestion) => suggestion.relevantFile,
                    ),
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });

            return prioritizedSuggestionsWithStatus;
        } catch (error) {
            this.logger.log({
                message: `Failed to prioritize suggestions by file for PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    suggestionsCount: suggestions.length,
                    limitPerFile,
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });
        }
    }

    /**
     * Prioritizes suggestions based on PR-specific logic
     */
    public async prioritizeSuggestionsByPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: any[],
        prLimit: number,
    ): Promise<any[]> {
        try {
            this.logger.log({
                message: `Prioritizing suggestions by PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    suggestionsCount: suggestions?.length,
                    suggestionsIds: suggestions?.map(
                        (suggestion) => suggestion.id,
                    ),
                    prLimit: prLimit,
                    filepaths: suggestions?.map(
                        (suggestion) => suggestion.relevantFile,
                    ),
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });

            const sortedSuggestions = this.sortSuggestionsByPriority(
                organizationAndTeamData,
                prNumber,
                suggestions,
            );

            const suggestionsWithStatus = sortedSuggestions
                .slice(0, prLimit)
                .map((suggestion) => ({
                    ...suggestion,
                    priorityStatus: PriorityStatus.PRIORITIZED,
                }));

            this.logger.log({
                message: `Suggestions prioritized by PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    suggestionsCount: suggestionsWithStatus?.length,
                    suggestionsIds: suggestionsWithStatus?.map(
                        (suggestion) => suggestion.id,
                    ),
                    prLimit: prLimit,
                    filepaths: suggestionsWithStatus?.map(
                        (suggestion) => suggestion.relevantFile,
                    ),
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });

            return suggestionsWithStatus;
        } catch (error) {
            this.logger.log({
                message: `Failed to prioritize suggestions by PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    suggestionsCount: suggestions.length,
                    prLimit: prLimit,
                    prNumber: prNumber,
                    organizationAndTeamData,
                },
            });
            return [];
        }
    }

    /**
     * Comprehensive method to sort and prioritize suggestions
     */
    public async sortAndPrioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfig: CodeReviewConfig,
        pullRequest: { number: number },
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
    ): Promise<{
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[];
        allDiscardedSuggestions: Partial<CodeSuggestion>[];
    }> {
        try {
            const allDiscardedSuggestions: Partial<CodeSuggestion>[] = [
                ...discardedSuggestionsBySafeGuard,
            ];

            let analyzedSuggestions;

            if (validSuggestionsToAnalyze?.length > 0) {
                analyzedSuggestions = await this.prioritizeSuggestions(
                    organizationAndTeamData,
                    codeReviewConfig.suggestionControl,
                    pullRequest.number,
                    validSuggestionsToAnalyze,
                );
            } else {
                analyzedSuggestions = {
                    prioritizedSuggestions: [],
                    discardedSuggestionsBySeverityOrQuantity: [],
                };
            }

            const prioritizedSuggestions =
                analyzedSuggestions.prioritizedSuggestions;

            allDiscardedSuggestions.push(
                ...analyzedSuggestions.discardedSuggestionsBySeverityOrQuantity,
            );

            if (prioritizedSuggestions?.length <= 0) {
                return {
                    sortedPrioritizedSuggestions: [],
                    allDiscardedSuggestions,
                };
            }

            let sortedPrioritizedSuggestions =
                this.sortSuggestionsByFilePathAndSeverity(
                    prioritizedSuggestions,
                    codeReviewConfig.suggestionControl.groupingMode,
                );

            if (
                codeReviewConfig.suggestionControl.groupingMode ===
                GroupingModeSuggestions.FULL
            ) {
                sortedPrioritizedSuggestions =
                    await this.commentManagerService.enrichParentSuggestionsWithRelated(
                        sortedPrioritizedSuggestions,
                    );

                sortedPrioritizedSuggestions = sortedPrioritizedSuggestions.map(
                    (suggestion) => {
                        if (
                            suggestion.clusteringInformation?.type ===
                            ClusteringType.RELATED
                        ) {
                            return {
                                ...suggestion,
                                priorityStatus:
                                    PriorityStatus.DISCARDED_BY_CLUSTERING,
                                deliveryStatus: DeliveryStatus.NOT_SENT,
                            };
                        }
                        return suggestion;
                    },
                );
            }

            return { sortedPrioritizedSuggestions, allDiscardedSuggestions };
        } catch (error) {
            this.logger.log({
                message: `Error when trying to sort and prioritize suggestions for PR#${pullRequest.number}`,
                error: error,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    pullRequest,
                    validSuggestionsToAnalyze,
                },
            });

            return {
                sortedPrioritizedSuggestions: validSuggestionsToAnalyze,
                allDiscardedSuggestions: discardedSuggestionsBySafeGuard,
            };
        }
    }

    /**
     * Combines suggestions with their severity levels
     * @private
     */
    private mergeSuggestionsWithSeverity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        severityLevels: Map<number, string>,
    ): Partial<CodeSuggestion>[] {
        try {
            return suggestions.map((suggestion, index) => ({
                ...suggestion,
                id: suggestion?.id || uuidv4(),
                severity: severityLevels.get(index + 1) || 'medium',
            }));
        } catch (error) {
            this.logger.error({
                message: `Failed to merge suggestions with severity levels for PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    suggestionsCount: suggestions.length,
                    severityLevelsCount: severityLevels.size,
                    organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
            return suggestions;
        }
    }

    /**
     * Analyzes and assigns severity levels to code suggestions
     * @public
     */
    public async analyzeSuggestionsSeverity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: any[],
        selectedCategories: ReviewOptions,
    ) {
        try {
            if (!codeSuggestions?.length) {
                return [];
            }

            const chain =
                await this.aiAnalysisService.createSeverityAnalysisChain(
                    organizationAndTeamData,
                    prNumber,
                    LLMModelProvider.CHATGPT_4_ALL,
                    codeSuggestions,
                    structuredClone(selectedCategories),
                );

            const result = await chain.invoke({});
            const severityLevels = this.parseSeverityResults(
                organizationAndTeamData,
                result,
            );

            const suggestionsWithSeverity = this.mergeSuggestionsWithSeverity(
                organizationAndTeamData,
                prNumber,
                codeSuggestions,
                severityLevels,
            );

            const suggestionsLog = suggestionsWithSeverity?.map(
                (suggestion) => ({
                    id: suggestion?.id,
                    category: suggestion?.label,
                    severity: suggestion?.severity,
                    filePath: suggestion?.relevantFile,
                }),
            );

            this.logger.log({
                message: `Suggestions analyzed with severity for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    suggestions: suggestionsLog,
                    prNumber: prNumber,
                },
            });

            return suggestionsWithSeverity;
        } catch (error) {
            this.logger.log({
                message: `Failed to analyze suggestions severity for PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    suggestionsCount: codeSuggestions?.length,
                    organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
        }
    }

    /**
     * Interprets the severity analysis results
     * @private
     */
    private parseSeverityResults(
        organizationAndTeamData: OrganizationAndTeamData,
        result: string,
    ): Map<number, string> {
        try {
            const severityMap = new Map();
            const matches = result.match(/<results>([\s\S]*?)<\/results>/);

            if (matches && matches[1]) {
                matches[1].split('\n').forEach((line) => {
                    const [id, severity] = line.trim().split('|');
                    if (id && severity) {
                        severityMap.set(parseInt(id), severity);
                    }
                });
            }

            return severityMap;
        } catch (error) {
            this.logger.log({
                message: 'Failed to parse severity results',
                context: SuggestionService.name,
                error: error,
                metadata: {
                    resultContent: result,
                    organizationAndTeamData,
                },
            });
            return new Map();
        }
    }

    private async normalizeSeverity(
        suggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const updatedSuggestions = suggestions.map((s) => ({ ...s }));

        const severityRank = {
            low: 1,
            medium: 2,
            high: 3,
            critical: 4,
        };

        // Creates a map of groups (parent -> related suggestions)
        const groupsMap = new Map<string, string[]>();

        // Populates the initial map with parents
        updatedSuggestions.forEach((s) => {
            if (s.clusteringInformation?.type === ClusteringType.PARENT) {
                groupsMap.set(s.id, [
                    s.id,
                    ...(s.clusteringInformation.relatedSuggestionsIds || []),
                ]);
            }
        });

        // For each group, finds the highest severity and normalizes
        groupsMap.forEach((groupIds, parentId) => {
            // Gets all suggestions in the group (parent + related)
            const groupSuggestions = updatedSuggestions.filter((s) =>
                groupIds.includes(s.id),
            );

            // Finds the highest severity in the group
            const highestSeverity = groupSuggestions.reduce(
                (highest, current) => {
                    const currentRank = severityRank[current.severity] || 0;
                    const highestRank = severityRank[highest] || 0;

                    return currentRank > highestRank
                        ? current.severity
                        : highest;
                },
                'low',
            );

            // Updates the severity of all suggestions in the group
            groupSuggestions.forEach((suggestion) => {
                const suggestionToUpdate = updatedSuggestions.find(
                    (s) => s.id === suggestion.id,
                );
                if (suggestionToUpdate) {
                    suggestionToUpdate.severity = highestSeverity;
                }
            });
        });

        return updatedSuggestions;
    }

    /**
     * Calculates a priority score for a suggestion based on category and severity
     * @public
     */
    public async calculateSuggestionRankScore(
        suggestion: Partial<CodeSuggestion>,
    ): Promise<number> {
        const categoryWeights = {
            kody_rules: 100,
            breaking_changes: 100,
            security: 50,
            potential_issues: 40,
            error_handling: 30,
            performance_and_optimization: 25,
            maintainability: 20,
            refactoring: 15,
            code_style: 10,
            documentation_and_comments: 5,
        };

        const severityModifiers = {
            critical: 50,
            high: 30,
            medium: 20,
            low: 10,
        };

        const categoryWeight = categoryWeights[suggestion.label] || 0;
        const severityModifier = severityModifiers[suggestion.severity] || 0;

        return categoryWeight + severityModifier;
    }

    /**
     * Verifies which suggestions were sent as comments and updates their status
     * @public
     */
    public async verifyIfSuggestionsWereSent(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[],
        commentResults: CommentResult[],
    ): Promise<Partial<CodeSuggestion>[]> {
        try {
            const suggestionsWithStatus = sortedPrioritizedSuggestions?.map(
                (suggestion) => {
                    const commentResult = commentResults?.find(
                        (result) => result?.comment?.suggestion === suggestion,
                    );

                    if (
                        commentResult?.codeReviewFeedbackData &&
                        commentResult?.deliveryStatus !== DeliveryStatus.FAILED
                    ) {
                        return {
                            ...suggestion,
                            deliveryStatus: commentResult?.deliveryStatus,
                            implementationStatus:
                                ImplementationStatus.NOT_IMPLEMENTED,
                            comment: {
                                ...(suggestion?.comment || {}),
                                id: commentResult?.codeReviewFeedbackData
                                    ?.commentId,
                                pullRequestReviewId:
                                    commentResult?.codeReviewFeedbackData
                                        ?.pullRequestReviewId,
                            },
                        };
                    }

                    return {
                        ...suggestion,
                        deliveryStatus:
                            commentResult?.deliveryStatus ||
                            DeliveryStatus.FAILED,
                    };
                },
            ) as Partial<CodeSuggestion>[];

            return suggestionsWithStatus;
        } catch (error) {
            this.logger.log({
                message: `Error when trying to verify if suggestions were sent for PR#${pullRequest.number}`,
                error: error,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    pullRequest,
                    sortedPrioritizedSuggestions,
                    commentResults,
                },
            });
            return sortedPrioritizedSuggestions;
        }
    }
}
