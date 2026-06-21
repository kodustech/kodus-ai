import { createLogger } from '@kodus/flow';
import { BYOKConfig, LLMModelProvider } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';

import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { ISuggestionService } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    ClusteringType,
    CodeReviewConfig,
    CodeReviewVersion,
    CodeSuggestion,
    CommentResult,
    GroupingModeSuggestions,
    ImplementedSuggestionsToAnalyze,
    LimitationType,
    ReviewModeResponse,
    ReviewOptions,
    SuggestionControlConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { extractLinesFromUnifiedDiff } from '@libs/common/utils/patch';
import { LLM_ANALYSIS_SERVICE_TOKEN } from './llmAnalysis.service';

import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    DocumentationContextItem,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { PullRequestReviewComment } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PullRequestsEntity } from '@libs/platformData/domain/pullRequests/entities/pullRequests.entity';

@Injectable()
export class SuggestionService implements ISuggestionService {
    private readonly logger = createLogger(SuggestionService.name);
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    /**
     * Removes suggestions related to files that already have saved suggestions
     */
    public async removeSuggestionsRelatedToSavedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: string,
        savedSuggestions: any[],
        newSuggestions: any[],
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
        organizationAndTeamData: OrganizationAndTeamData,
        codePatch: string,
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
                    LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                    codePatch,
                    filteredSuggestions,
                );

            if (implementedSuggestions && implementedSuggestions?.length > 0) {
                // Create lookup map for O(1) access instead of O(n) find per iteration
                const savedSuggestionsMap = new Map(
                    savedSuggestions?.map((s) => [s.id, s]) ?? [],
                );

                for (const suggestion of implementedSuggestions) {
                    const savedSuggestion = savedSuggestionsMap.get(
                        suggestion.id,
                    );

                    if (savedSuggestion) {
                        await this.pullRequestService.updateSuggestion(
                            savedSuggestion.id,
                            {
                                implementationStatus:
                                    suggestion.implementationStatus,
                                updatedAt: new Date().toISOString(),
                            },
                            organizationAndTeamData,
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
            codeSuggestions: filteredSuggestions,
        };
    }

    /**
     * Filters suggestions to only include those that are relevant to changed lines in the diff.
     * A suggestion is kept if there's ANY overlap between its line range and the diff's visible lines.
     *
     * Uses the standard interval overlap formula:
     * Two ranges [A.start, A.end] and [B.start, B.end] overlap if:
     * A.start <= B.end AND B.start <= A.end
     */
    public filterSuggestionsCodeDiff(
        patchWithLinesStr: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ) {
        const visibleRanges = extractLinesFromUnifiedDiff(patchWithLinesStr);

        return codeSuggestions?.filter((suggestion) => {
            const suggestionStart = suggestion?.relevantLinesStart;
            const suggestionEnd = suggestion?.relevantLinesEnd;

            // Skip suggestions with invalid line ranges
            if (suggestionStart == null || suggestionEnd == null) {
                return false;
            }

            // Check if suggestion overlaps with any visible range in the diff
            return visibleRanges.some(
                (range) =>
                    suggestionStart <= range.end &&
                    suggestionEnd >= range.start,
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
        relevantContent: string,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
        byokConfig: BYOKConfig,
        crossFileSnippets?: CrossFileContextSnippet[],
        remoteCommands?: RemoteCommands,
        memories?: Array<Partial<IKodyRule>>,
        externalReferences?: unknown[],
        externalReferenceErrors?: unknown[] | string,
        getFreshCloneParams?: () => Promise<CreateSandboxParams>,
        documentationContext?: DocumentationContextItem[],
    ) {
        if (!suggestions?.length) {
            return suggestions;
        }

        return this.aiAnalysisService.filterSuggestionsSafeGuard(
            organizationAndTeamData,
            prNumber,
            file,
            relevantContent,
            codeDiff,
            suggestions,
            languageResultPrompt,
            reviewMode,
            byokConfig,
            crossFileSnippets,
            remoteCommands,
            memories,
            externalReferences,
            externalReferenceErrors,
            getFreshCloneParams,
            documentationContext,
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
        return (allSuggestions || [])
            ?.filter(
                (suggestion) =>
                    !!suggestion.id &&
                    !(filteredSuggestions || [])?.some(
                        (filtered) =>
                            filtered?.id && filtered?.id === suggestion?.id,
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
        severityLimits?: {
            low: number;
            medium: number;
            high: number;
            critical: number;
        },
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

        let prioritizedByQuantity: Partial<CodeSuggestion>[];

        if (limitationType === LimitationType.SEVERITY && severityLimits) {
            // Nova lógica para limitação por severidade
            prioritizedByQuantity =
                await this.prioritizeSuggestionsBySeverityLimits(
                    organizationAndTeamData,
                    prNumber,
                    prioritizedBySeverity,
                    severityLimits,
                );
        } else if (!limitationType || limitationType === LimitationType.FILE) {
            // Lógica existente para limitação por arquivo
            prioritizedByQuantity = await this.prioritizeSuggestionsByFile(
                organizationAndTeamData,
                prNumber,
                prioritizedBySeverity,
                maxSuggestions,
            );
        } else {
            // Lógica existente para limitação por PR
            prioritizedByQuantity = await this.prioritizeSuggestionsByPR(
                organizationAndTeamData,
                prNumber,
                prioritizedBySeverity,
                maxSuggestions,
            );
        }

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
     * Prioritizes suggestions based on severity limits
     */
    public async prioritizeSuggestionsBySeverityLimits(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        severityLimits: {
            low: number;
            medium: number;
            high: number;
            critical: number;
        },
    ): Promise<Partial<CodeSuggestion>[]> {
        try {
            this.logger.log({
                message: `Prioritizing suggestions by severity limits for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    severityLimits,
                    totalSuggestions: suggestions.length,
                    organizationAndTeamData,
                    prNumber,
                },
            });

            // PERF: Categorizar sugestões em uma única passagem (antes eram 4 filters)
            const categorizedSuggestions: Record<
                string,
                Partial<CodeSuggestion>[]
            > = {
                critical: [],
                high: [],
                medium: [],
                low: [],
            };

            for (const s of suggestions) {
                const severity = s.severity?.toLowerCase() || 'low';
                if (categorizedSuggestions[severity]) {
                    categorizedSuggestions[severity].push(s);
                }
            }

            // Ordenar cada categoria por rankScore (decrescente)
            for (const severity of Object.keys(categorizedSuggestions)) {
                categorizedSuggestions[severity].sort((a, b) => {
                    const scoreA = a.rankScore || 0;
                    const scoreB = b.rankScore || 0;
                    return scoreB - scoreA;
                });
            }

            // Aplicar limites por severidade
            const prioritizedSuggestions: Partial<CodeSuggestion>[] = [];

            // Prioridade: critical > high > medium > low
            for (const severity of ['critical', 'high', 'medium', 'low']) {
                const limit = severityLimits[severity];
                const suggestionsOfSeverity = categorizedSuggestions[severity];

                if (suggestionsOfSeverity.length > 0) {
                    // Se limit = 0, traz todas (sem filtro)
                    // Se limit > 0, traz até o limite
                    const selected =
                        limit === 0
                            ? suggestionsOfSeverity
                            : suggestionsOfSeverity.slice(0, limit);

                    // PERF: Mutar in-place ao invés de criar novos objetos com spread
                    for (const s of selected) {
                        s.priorityStatus = PriorityStatus.PRIORITIZED;
                        s.deliveryStatus = DeliveryStatus.NOT_SENT;
                        prioritizedSuggestions.push(s);
                    }
                }
            }

            this.logger.log({
                message: `Suggestions prioritized by severity limits for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    severityLimits,
                    totalSuggestions: suggestions.length,
                    prioritizedCount: prioritizedSuggestions.length,
                    breakdown: {
                        critical: {
                            available: categorizedSuggestions.critical.length,
                            limit: severityLimits.critical,
                            selected: prioritizedSuggestions.filter(
                                (s) => s.severity?.toLowerCase() === 'critical',
                            ).length,
                        },
                        high: {
                            available: categorizedSuggestions.high.length,
                            limit: severityLimits.high,
                            selected: prioritizedSuggestions.filter(
                                (s) => s.severity?.toLowerCase() === 'high',
                            ).length,
                        },
                        medium: {
                            available: categorizedSuggestions.medium.length,
                            limit: severityLimits.medium,
                            selected: prioritizedSuggestions.filter(
                                (s) => s.severity?.toLowerCase() === 'medium',
                            ).length,
                        },
                        low: {
                            available: categorizedSuggestions.low.length,
                            limit: severityLimits.low,
                            selected: prioritizedSuggestions.filter(
                                (s) => s.severity?.toLowerCase() === 'low',
                            ).length,
                        },
                    },
                    organizationAndTeamData,
                    prNumber,
                },
            });

            return prioritizedSuggestions;
        } catch (error) {
            this.logger.error({
                message: `Error prioritizing suggestions by severity limits for PR#${prNumber}`,
                error,
                context: SuggestionService.name,
                metadata: { severityLimits, organizationAndTeamData, prNumber },
            });

            // Fallback: retorna todas as sugestões como novas cópias (sem mutação)
            return suggestions.map((s) => ({
                ...s,
                priorityStatus: PriorityStatus.PRIORITIZED,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            }));
        }
    }

    /**
     * Adds related suggestions when parent suggestions are prioritized
     */
    public async addRelatedSuggestionsFromPrioritizedParents(
        suggestionsClustered: Partial<CodeSuggestion>[],
        prioritizedByQuantity: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const prioritizedIds = new Set(prioritizedByQuantity.map((s) => s.id));

        const relatedToPrioritized = suggestionsClustered.filter(
            (suggestion) =>
                suggestion.clusteringInformation?.type ===
                    ClusteringType.RELATED &&
                suggestion.clusteringInformation?.parentSuggestionId &&
                prioritizedIds.has(
                    suggestion.clusteringInformation.parentSuggestionId,
                ),
        );

        const relatedWithStatus = relatedToPrioritized.map((suggestion) => ({
            ...suggestion,
            priorityStatus: PriorityStatus.PRIORITIZED_BY_CLUSTERING,
        }));

        return [...prioritizedByQuantity, ...relatedWithStatus];
    }

    /**
     * Determina se deve aplicar filtros às Kody Rules
     */
    private shouldApplyFiltersToKodyRules(
        suggestionControl: SuggestionControlConfig,
    ): boolean {
        return suggestionControl.applyFiltersToKodyRules === true;
    }

    private async applyFiltersToSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: any[],
        shouldApplyFilters: boolean,
    ): Promise<{
        prioritizedSuggestions: any[];
        discardedSuggestionsBySeverityOrQuantity: any[];
    }> {
        if (!shouldApplyFilters) {
            // PERF: Mutar in-place ao invés de criar novos objetos
            for (const s of suggestions) {
                s.priorityStatus = PriorityStatus.PRIORITIZED;
            }
            return {
                prioritizedSuggestions: suggestions,
                discardedSuggestionsBySeverityOrQuantity: [],
            };
        }

        return this.prioritizeSuggestionsLegacy(
            organizationAndTeamData,
            suggestionControl,
            prNumber,
            suggestions,
        );
    }

    private getPrimaryBrokenKodyRuleId(suggestion: any): string | null {
        const brokenKodyRulesIds = suggestion?.brokenKodyRulesIds;

        if (
            !Array.isArray(brokenKodyRulesIds) ||
            brokenKodyRulesIds.length < 1
        ) {
            return null;
        }

        const primaryRuleId = brokenKodyRulesIds[0];

        if (typeof primaryRuleId !== 'string' || !primaryRuleId.trim()) {
            return null;
        }

        return primaryRuleId;
    }

    private shouldClusterKodySuggestionByRuleId(suggestion: any): boolean {
        if (this.normalizeLabel(suggestion?.label) !== 'kody_rules') {
            return false;
        }

        if (suggestion?.clusteringInformation?.type) {
            return false;
        }

        return !!this.getPrimaryBrokenKodyRuleId(suggestion);
    }

    private clusterKodySuggestionsByRuleIdForFullMode(
        suggestions: any[],
    ): any[] {
        const groupedByRule = new Map<string, any[]>();
        const nonClusterableSuggestions: any[] = [];

        for (const suggestion of suggestions) {
            if (!this.shouldClusterKodySuggestionByRuleId(suggestion)) {
                nonClusterableSuggestions.push(suggestion);
                continue;
            }

            const primaryRuleId = this.getPrimaryBrokenKodyRuleId(suggestion);

            if (!primaryRuleId) {
                nonClusterableSuggestions.push(suggestion);
                continue;
            }

            if (!groupedByRule.has(primaryRuleId)) {
                groupedByRule.set(primaryRuleId, []);
            }

            groupedByRule.get(primaryRuleId)?.push(suggestion);
        }

        const clusteredSuggestions: any[] = [];

        for (const [, groupedSuggestions] of groupedByRule.entries()) {
            if (groupedSuggestions.length <= 1) {
                clusteredSuggestions.push(groupedSuggestions[0]);
                continue;
            }

            const sortedGroup = [...groupedSuggestions].sort((a, b) =>
                String(a?.id || '').localeCompare(String(b?.id || '')),
            );

            const parentSuggestion = sortedGroup.find((s) => s?.id);

            if (!parentSuggestion) {
                clusteredSuggestions.push(...groupedSuggestions);
                continue;
            }

            const relatedSuggestions = sortedGroup.filter(
                (s) => s !== parentSuggestion,
            );

            const problemDescription =
                parentSuggestion?.oneSentenceSummary ||
                parentSuggestion?.suggestionContent ||
                'This Kody Rule issue appears in multiple locations.';

            const actionStatement =
                'Please fix this Kody Rule violation in all listed locations.';

            clusteredSuggestions.push({
                ...parentSuggestion,
                clusteringInformation: {
                    type: ClusteringType.PARENT,
                    relatedSuggestionsIds: relatedSuggestions
                        .map((s) => s?.id)
                        .filter(Boolean),
                    problemDescription,
                    actionStatement,
                },
            });

            for (const relatedSuggestion of relatedSuggestions) {
                clusteredSuggestions.push({
                    ...relatedSuggestion,
                    clusteringInformation: {
                        type: ClusteringType.RELATED,
                        parentSuggestionId: parentSuggestion.id,
                    },
                });
            }
        }

        return [...nonClusterableSuggestions, ...clusteredSuggestions];
    }

    public async prioritizeSuggestionsLegacy(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: any[],
        byokConfig?: BYOKConfig,
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

        let severityLevelFilterWithConditional = severityLevelFilter;

        if (limitationType === LimitationType.SEVERITY) {
            severityLevelFilterWithConditional = SeverityLevel.LOW;
        }

        let refinedSuggestions = suggestions;

        if (groupingMode === GroupingModeSuggestions.FULL) {
            refinedSuggestions =
                this.clusterKodySuggestionsByRuleIdForFullMode(
                    refinedSuggestions,
                );
        }

        if (
            groupingMode === GroupingModeSuggestions.SMART ||
            groupingMode === GroupingModeSuggestions.FULL
        ) {
            const alreadyClusteredSuggestions = refinedSuggestions.filter(
                (suggestion) => !!suggestion?.clusteringInformation?.type,
            );

            const suggestionsToCluster = refinedSuggestions.filter(
                (suggestion) => !suggestion?.clusteringInformation?.type,
            );

            const suggestionsClustered =
                suggestionsToCluster.length > 0
                    ? await this.commentManagerService.repeatedCodeReviewSuggestionClustering(
                          organizationAndTeamData,
                          prNumber,
                          LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                          suggestionsToCluster,
                          byokConfig,
                      )
                    : [];

            refinedSuggestions = await this.normalizeSeverity([
                ...alreadyClusteredSuggestions,
                ...suggestionsClustered,
            ]);
        }

        const { prioritizedBySeverity, discardedBySeverity } =
            await this.processSeverityFilter(
                refinedSuggestions,
                severityLevelFilterWithConditional,
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
            suggestionControl.severityLimits,
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

    public async prioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: any[],
        byokConfig?: BYOKConfig,
    ): Promise<{
        prioritizedSuggestions: any[];
        discardedSuggestionsBySeverityOrQuantity: any[];
    }> {
        try {
            const hasKodyRules = suggestions.some((s) => {
                const normalizedLabel = this.normalizeLabel(s.label);
                return normalizedLabel === 'kody_rules';
            });

            if (hasKodyRules) {
                this.logger.log({
                    message: `✅ Kody Rules detected for PR#${prNumber} - using enhanced control logic`,
                    context: SuggestionService.name,
                    metadata: {
                        totalSuggestions: suggestions.length,
                        detectedLabels: suggestions.map((s) => ({
                            original: s.label,
                            normalized: this.normalizeLabel(s.label),
                        })),
                        applyFiltersToKodyRules:
                            suggestionControl.applyFiltersToKodyRules,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return this.prioritizeSuggestionsWithKodyRulesControl(
                    organizationAndTeamData,
                    suggestionControl,
                    prNumber,
                    suggestions,
                );
            }

            return this.prioritizeSuggestionsLegacy(
                organizationAndTeamData,
                suggestionControl,
                prNumber,
                suggestions,
                byokConfig,
            );
        } catch (error) {
            this.logger.error({
                message: `Error in prioritizeSuggestions for PR#${prNumber}`,
                error,
                context: SuggestionService.name,
                metadata: { organizationAndTeamData, prNumber },
            });

            // Fallback para lógica original
            return this.prioritizeSuggestionsLegacy(
                organizationAndTeamData,
                suggestionControl,
                prNumber,
                suggestions,
                byokConfig,
            );
        }
    }

    private async prioritizeSuggestionsWithKodyRulesControl(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: any[],
        byokConfig?: BYOKConfig,
    ): Promise<{
        prioritizedSuggestions: any[];
        discardedSuggestionsBySeverityOrQuantity: any[];
    }> {
        const shouldApplyFiltersToKodyRules =
            this.shouldApplyFiltersToKodyRules(suggestionControl);

        // Se deve aplicar filtros às Kody Rules, processa TODAS as sugestões juntas
        if (shouldApplyFiltersToKodyRules) {
            this.logger.log({
                message: `Applying ALL filters to ALL suggestions (including Kody Rules) for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    totalSuggestions: suggestions.length,
                    applyFiltersToKodyRules: true,
                    organizationAndTeamData,
                    prNumber,
                },
            });

            return this.prioritizeSuggestionsLegacy(
                organizationAndTeamData,
                suggestionControl,
                prNumber,
                suggestions,
                byokConfig,
            );
        }

        // Se NÃO deve aplicar filtros às Kody Rules, separa e processa diferenciadamente
        let kodyRulesSuggestions = suggestions.filter((s) => {
            const normalizedLabel = this.normalizeLabel(s.label);
            return normalizedLabel === 'kody_rules';
        });
        const normalSuggestions = suggestions.filter((s) => {
            const normalizedLabel = this.normalizeLabel(s.label);
            return normalizedLabel !== 'kody_rules';
        });

        this.logger.log({
            message: `Separating suggestions for PR#${prNumber} - Kody Rules exempt from filters`,
            context: SuggestionService.name,
            metadata: {
                totalSuggestions: suggestions.length,
                kodyRulesCount: kodyRulesSuggestions.length,
                normalSuggestionsCount: normalSuggestions.length,
                kodyRulesLabels: kodyRulesSuggestions.map((s) => ({
                    original: s.label,
                    normalized: this.normalizeLabel(s.label),
                })),
                applyFiltersToKodyRules: false,
                organizationAndTeamData,
                prNumber,
            },
        });

        if (suggestionControl.groupingMode === GroupingModeSuggestions.FULL) {
            kodyRulesSuggestions =
                this.clusterKodySuggestionsByRuleIdForFullMode(
                    kodyRulesSuggestions,
                );
        }

        const allPrioritized: any[] = [];
        const allDiscarded: any[] = [];

        // Processa sugestões normais com filtros
        if (normalSuggestions.length > 0) {
            const normalResult = await this.prioritizeSuggestionsLegacy(
                organizationAndTeamData,
                suggestionControl,
                prNumber,
                normalSuggestions,
            );
            allPrioritized.push(...normalResult.prioritizedSuggestions);
            allDiscarded.push(
                ...normalResult.discardedSuggestionsBySeverityOrQuantity,
            );
        }

        // Processa Kody Rules SEM filtros - todas passam
        if (kodyRulesSuggestions.length > 0) {
            // PERF: Mutar in-place ao invés de criar novos objetos
            for (const s of kodyRulesSuggestions) {
                s.priorityStatus = PriorityStatus.PRIORITIZED;
                s.deliveryStatus = DeliveryStatus.NOT_SENT;
            }
            allPrioritized.push(...kodyRulesSuggestions);
        }

        this.logger.log({
            message: `Suggestions processed with Kody Rules control for PR#${prNumber}`,
            context: SuggestionService.name,
            metadata: {
                totalPrioritized: allPrioritized.length,
                totalDiscarded: allDiscarded.length,
                kodyRulesPrioritized: allPrioritized.filter(
                    (s) => this.normalizeLabel(s.label) === 'kody_rules',
                ).length,
                kodyRulesDiscarded: allDiscarded.filter(
                    (s) => this.normalizeLabel(s.label) === 'kody_rules',
                ).length,
                organizationAndTeamData,
                prNumber,
            },
        });

        return {
            prioritizedSuggestions: allPrioritized,
            discardedSuggestionsBySeverityOrQuantity: allDiscarded,
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

            if (limitPerFile === 0) {
                limitPerFile = suggestions?.length || 0;
            }

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

            const limitedSuggestions: Partial<CodeSuggestion>[] =
                prLimit === 0
                    ? sortedSuggestions
                    : sortedSuggestions.slice(0, prLimit);

            const suggestionsWithStatus = limitedSuggestions.map(
                (suggestion) => ({
                    ...suggestion,
                    priorityStatus: PriorityStatus.PRIORITIZED,
                }),
            );

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
                    codeReviewConfig?.byokConfig,
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

                // Separate the RELATED suggestions (discarded by clustering) from the prioritized suggestions
                const relatedSuggestions = sortedPrioritizedSuggestions.filter(
                    (suggestion) =>
                        suggestion.clusteringInformation?.type ===
                        ClusteringType.RELATED,
                );

                // Remove the RELATED suggestions from the prioritized suggestions array
                sortedPrioritizedSuggestions =
                    sortedPrioritizedSuggestions.filter(
                        (suggestion) =>
                            suggestion.clusteringInformation?.type !==
                            ClusteringType.RELATED,
                    );

                // Mark the RELATED suggestions as discarded and add to the discarded suggestions array
                const discardedRelatedSuggestions = relatedSuggestions.map(
                    (suggestion) => ({
                        ...suggestion,
                        priorityStatus: PriorityStatus.DISCARDED_BY_CLUSTERING,
                        deliveryStatus: DeliveryStatus.NOT_SENT,
                    }),
                );

                allDiscardedSuggestions.push(...discardedRelatedSuggestions);
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
        severityLevels: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[] {
        try {
            if (!suggestions?.length) {
                return [];
            }

            // Create lookup map for O(1) access instead of O(n) find per iteration
            const severityMap = new Map(
                severityLevels?.map((level) => [level.id, level.severity]) ??
                    [],
            );

            return suggestions.map((suggestion) => {
                const severity = severityMap.get(suggestion.id) || 'medium';

                if (!severityMap.has(suggestion.id)) {
                    this.logger.warn({
                        message: `Suggestion severity not found in severity levels`,
                        context: SuggestionService.name,
                        metadata: {
                            suggestionId: suggestion.id,
                            suggestionLabel: suggestion.label,
                            prNumber,
                            organizationAndTeamData,
                        },
                    });
                }

                return {
                    ...suggestion,
                    severity,
                };
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to merge suggestions with severity levels for PR#${prNumber}`,
                context: SuggestionService.name,
                error: error,
                metadata: {
                    suggestionsCount: suggestions?.length,
                    severityLevelsCount: severityLevels?.length,
                    organizationAndTeamData,
                    prNumber: prNumber,
                },
            });

            // Em caso de erro, retorna as sugestões com severidade padrão
            return suggestions.map((suggestion) => {
                const defaultSeverity = suggestion?.severity || 'medium';

                this.logger.warn({
                    message: `Suggestion received default severity due to error in merge process`,
                    context: SuggestionService.name,
                    metadata: {
                        suggestionId: suggestion.id,
                        suggestionLabel: suggestion.label,
                        prNumber,
                        organizationAndTeamData,
                    },
                });

                return {
                    ...suggestion,
                    severity: defaultSeverity,
                };
            });
        }
    }

    /**
     * Analyzes and assigns severity levels to code suggestions
     * @public
     */
    public async analyzeSuggestionsSeverity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: CodeSuggestion[],
        selectedCategories: ReviewOptions,
        codeReviewVersion: CodeReviewVersion,
        byokConfig?: BYOKConfig,
    ) {
        try {
            if (!codeSuggestions?.length) {
                return [];
            }

            if (codeReviewVersion === CodeReviewVersion.v2) {
                return codeSuggestions;
            }

            const result =
                await this.aiAnalysisService.severityAnalysisAssignment(
                    organizationAndTeamData,
                    prNumber,
                    LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                    codeSuggestions,
                    byokConfig,
                );

            const suggestionsWithSeverity = this.mergeSuggestionsWithSeverity(
                organizationAndTeamData,
                prNumber,
                codeSuggestions,
                result,
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
        groupsMap.forEach((groupIds, _parentId) => {
            // Convert to Set for O(1) lookup instead of O(n) includes
            const groupIdSet = new Set(groupIds);

            // Gets all suggestions in the group (parent + related)
            const groupSuggestions = updatedSuggestions.filter((s) =>
                groupIdSet.has(s.id),
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
            // groupSuggestions already contains references to objects in updatedSuggestions
            for (const suggestion of groupSuggestions) {
                suggestion.severity = highestSeverity;
            }
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
                        const commentId =
                            commentResult?.codeReviewFeedbackData?.commentId;
                        const pullRequestReviewId =
                            commentResult?.codeReviewFeedbackData
                                ?.pullRequestReviewId;

                        if (!commentId || !pullRequestReviewId) {
                            this.logger.error({
                                message: `Suggestion enrichment missing comment IDs for PR#${pullRequest.number}`,
                                context: SuggestionService.name,
                                metadata: {
                                    prNumber: pullRequest.number,
                                    suggestionId: suggestion?.id,
                                    commentId,
                                    pullRequestReviewId,
                                    deliveryStatus:
                                        commentResult?.deliveryStatus,
                                    organizationAndTeamData,
                                },
                            });
                        }

                        return {
                            ...suggestion,
                            deliveryStatus: commentResult?.deliveryStatus,
                            implementationStatus:
                                ImplementationStatus.NOT_IMPLEMENTED,
                            comment: {
                                ...(suggestion?.comment || {}),
                                id: commentId,
                                pullRequestReviewId,
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

    /**
     * Extracts repriorized suggestions from comment results and removes them from discarded suggestions.
     * This prevents duplicate saves when a fallback suggestion replaces a failed prioritized suggestion.
     *
     * When a prioritized suggestion fails all retry attempts, it gets replaced by a fallback suggestion
     * from the discarded pool. The fallback suggestion is marked as REPRIORIZED and SENT.
     * This method extracts those repriorized suggestions and filters them out of the discarded array
     * to avoid saving them twice (once as sent, once as discarded).
     *
     * @public
     */
    public extractRepriorizedSuggestions(
        commentResults: CommentResult[],
        discardedSuggestions: Partial<CodeSuggestion>[],
    ): {
        repriorizedSuggestions: Partial<CodeSuggestion>[];
        filteredDiscardedSuggestions: Partial<CodeSuggestion>[];
    } {
        // Find all repriorized suggestions from comment results
        const repriorizedSuggestions: Partial<CodeSuggestion>[] = [];

        for (const result of commentResults) {
            const suggestion = result?.comment?.suggestion;
            if (
                suggestion?.priorityStatus === PriorityStatus.REPRIORIZED &&
                result?.deliveryStatus === DeliveryStatus.SENT
            ) {
                const repriorizedCommentId =
                    result?.codeReviewFeedbackData?.commentId;
                const repriorizedPullRequestReviewId =
                    result?.codeReviewFeedbackData?.pullRequestReviewId;

                if (
                    result?.codeReviewFeedbackData &&
                    (!repriorizedCommentId || !repriorizedPullRequestReviewId)
                ) {
                    this.logger.error({
                        message: `Repriorized suggestion enrichment missing comment IDs`,
                        context: SuggestionService.name,
                        metadata: {
                            suggestionId: suggestion?.id,
                            commentId: repriorizedCommentId,
                            pullRequestReviewId: repriorizedPullRequestReviewId,
                            deliveryStatus: result?.deliveryStatus,
                        },
                    });
                }

                repriorizedSuggestions.push({
                    ...suggestion,
                    deliveryStatus: DeliveryStatus.SENT,
                    implementationStatus: ImplementationStatus.NOT_IMPLEMENTED,
                    comment: result?.codeReviewFeedbackData
                        ? {
                              ...(suggestion?.comment || {}),
                              id: repriorizedCommentId,
                              pullRequestReviewId:
                                  repriorizedPullRequestReviewId,
                          }
                        : suggestion?.comment,
                });
            }
        }

        // Build a Set of repriorized suggestion IDs for efficient lookup
        const repriorizedIds = new Set(
            repriorizedSuggestions.map((s) => s.id).filter(Boolean),
        );

        // Filter out repriorized suggestions from discarded suggestions
        const filteredDiscardedSuggestions = discardedSuggestions.filter(
            (suggestion) => !repriorizedIds.has(suggestion.id),
        );

        return {
            repriorizedSuggestions,
            filteredDiscardedSuggestions,
        };
    }

    /**
     * Transforma commentResults de suggestions de PR level em ISuggestionByPR[]
     */
    public transformCommentResultsToPrLevelSuggestions(
        commentResults: any[],
    ): ISuggestionByPR[] {
        try {
            return commentResults
                .filter(
                    (result) =>
                        result?.comment?.type === 'pr_level' &&
                        result?.comment?.suggestion,
                )
                .map((result) => {
                    const suggestion = result.comment.suggestion;

                    return {
                        id: suggestion.id,
                        suggestionContent: suggestion.suggestionContent,
                        oneSentenceSummary: suggestion.oneSentenceSummary,
                        label: suggestion.label as LabelType,
                        severity: suggestion.severity as SeverityLevel,
                        brokenKodyRulesIds: suggestion.brokenKodyRulesIds || [],
                        priorityStatus: PriorityStatus.PRIORITIZED, // Default para PR level
                        deliveryStatus: result.deliveryStatus as DeliveryStatus,
                        comment: result.codeReviewFeedbackData
                            ? (() => {
                                  const prLevelCommentId =
                                      result.codeReviewFeedbackData.commentId;
                                  const prLevelReviewId =
                                      result.codeReviewFeedbackData
                                          .pullRequestReviewId;

                                  if (!prLevelCommentId || !prLevelReviewId) {
                                      this.logger.error({
                                          message: `PR-level suggestion missing comment IDs`,
                                          context: SuggestionService.name,
                                          metadata: {
                                              suggestionId: suggestion.id,
                                              commentId: prLevelCommentId,
                                              pullRequestReviewId:
                                                  prLevelReviewId,
                                              deliveryStatus:
                                                  result.deliveryStatus,
                                          },
                                      });
                                  }

                                  return {
                                      id: prLevelCommentId,
                                      pullRequestReviewId: prLevelReviewId,
                                  };
                              })()
                            : undefined,
                        files: {
                            violatedFileSha:
                                suggestion.files?.violatedFileSha || [],
                            relatedFileSha:
                                suggestion.files?.relatedFileSha || [],
                        },
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    };
                });
        } catch (error) {
            this.logger.error({
                message:
                    'Error transforming comment results to PR level suggestions',
                error,
                context: SuggestionService.name,
                metadata: { commentResultsCount: commentResults?.length },
            });
            return [];
        }
    }

    public async filterActiveReviewSuggestions<
        T extends { comment?: { id?: number | string } },
    >(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
        suggestions: T[];
    }): Promise<T[]> {
        const {
            organizationAndTeamData,
            repository,
            prNumber,
            platformType,
            suggestions,
        } = params;

        if (!suggestions?.length) {
            return suggestions;
        }

        const suggestionsWithCommentId = suggestions.filter(
            (suggestion) => suggestion?.comment?.id != null,
        );

        if (!suggestionsWithCommentId.length) {
            return suggestions;
        }

        try {
            const reviewComments =
                platformType === PlatformType.GITHUB
                    ? await this.codeManagementService.getPullRequestReviewThreads(
                          {
                              organizationAndTeamData,
                              repository,
                              prNumber,
                          },
                          platformType,
                      )
                    : await this.codeManagementService.getPullRequestReviewComments(
                          {
                              organizationAndTeamData,
                              repository,
                              prNumber,
                          },
                          platformType,
                      );

            if (!reviewComments?.length) {
                return suggestions;
            }

            const activeCommentIds = new Set(
                reviewComments
                    .filter((comment) =>
                        this.isActiveReviewComment(comment, platformType),
                    )
                    .map((comment) =>
                        this.getReviewCommentMatchId(comment, platformType),
                    )
                    .filter(Boolean),
            );

            if (!activeCommentIds.size) {
                return [];
            }

            return suggestions.filter((suggestion) => {
                const suggestionCommentId = suggestion?.comment?.id;

                if (suggestionCommentId == null) {
                    return true;
                }

                return activeCommentIds.has(String(suggestionCommentId));
            });
        } catch (error) {
            this.logger.warn({
                message: `Failed to filter active review suggestions for PR#${prNumber}`,
                context: SuggestionService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repositoryName: repository?.name,
                    platformType,
                    suggestionsCount: suggestions.length,
                },
                error,
            });

            return suggestions;
        }
    }

    /**
     * Resolves comments on the platform (GitHub, etc.) for implemented suggestions
     */
    public async resolveImplementedSuggestionsOnPlatform({
        organizationAndTeamData,
        repository,
        prNumber,
        platformType,
        dryRun,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
        dryRun?: CodeReviewPipelineContext['dryRun'];
    }) {
        if (dryRun?.enabled) {
            return;
        }

        try {
            const codeManagementRequestData = {
                organizationAndTeamData,
                repository: {
                    id: repository.id,
                    name: repository.name,
                },
                prNumber: prNumber,
            };

            const isPlatformTypeGithub: boolean =
                platformType === PlatformType.GITHUB;

            const pr =
                await this.pullRequestService.findByNumberAndRepositoryName(
                    prNumber,
                    repository.name,
                    organizationAndTeamData,
                );

            if (!pr) {
                this.logger.warn({
                    message: `PR #${prNumber} not found, skipping comment resolution.`,
                    context: SuggestionService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repositoryName: repository.name,
                    },
                });
                return;
            }

            const implementedSuggestionsCommentIds =
                this.getImplementedSuggestionsCommentIds(pr);

            if (implementedSuggestionsCommentIds.length === 0) {
                return;
            }

            let reviewComments = [];

            /**
             * Marking comments as resolved in github needs to be done using another API.
             * Marking comments as resolved in github also is done using threadId rather than the comment Id.
             */
            if (isPlatformTypeGithub) {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewThreads(
                        codeManagementRequestData,
                    );
            } else {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewComments(
                        codeManagementRequestData,
                    );
            }

            if (reviewComments?.length === 0) {
                this.logger.warn({
                    message: `No review comments found for PR#${prNumber}`,
                    context: SuggestionService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repositoryName: repository.name,
                    },
                });
                return;
            }

            const foundComments = isPlatformTypeGithub
                ? reviewComments.filter((comment) =>
                      implementedSuggestionsCommentIds.includes(
                          Number(comment.fullDatabaseId),
                      ),
                  )
                : platformType === PlatformType.AZURE_REPOS
                  ? reviewComments.filter((comment) =>
                        implementedSuggestionsCommentIds.includes(
                            Number(comment.threadId),
                        ),
                    )
                  : reviewComments.filter((comment) =>
                        implementedSuggestionsCommentIds.includes(comment.id),
                    );

            const unresolvedComments = foundComments?.filter(
                (comment: PullRequestReviewComment) => !comment.isResolved,
            );

            if (unresolvedComments?.length > 0) {
                const promises = unresolvedComments.map(
                    async (foundComment: PullRequestReviewComment) => {
                        const commentId =
                            platformType === PlatformType.BITBUCKET
                                ? foundComment.id
                                : platformType === PlatformType.FORGEJO
                                  ? null
                                  : foundComment.threadId;

                        if (commentId == null) {
                            return null;
                        }

                        return this.codeManagementService.markReviewCommentAsResolved(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.number,
                                commentId: commentId,
                            },
                        );
                    },
                );

                // timeout mechanism for the Promise.allSettled operation to prevent potential hanging.
                await Promise.race([
                    Promise.allSettled(promises),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('Operation timed out')),
                            30000,
                        ),
                    ),
                ]);
            }
        } catch (error) {
            this.logger.error({
                message: `Error while resolving comments for PR#${prNumber}`,
                context: SuggestionService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repositoryName: repository.name,
                },
            });
            return;
        }
    }

    private getImplementedSuggestionsCommentIds(
        pr: PullRequestsEntity,
    ): number[] {
        const implementedSuggestionsCommentIds: number[] = [];

        pr.files?.forEach((file) => {
            if (file.suggestions.length > 0) {
                file.suggestions
                    ?.filter(
                        (suggestion) =>
                            suggestion.comment &&
                            suggestion.implementationStatus !==
                                ImplementationStatus.NOT_IMPLEMENTED &&
                            suggestion.deliveryStatus === DeliveryStatus.SENT,
                    )
                    .forEach((filteredSuggestion) => {
                        implementedSuggestionsCommentIds.push(
                            filteredSuggestion.comment.id,
                        );
                    });
            }
        });

        return implementedSuggestionsCommentIds;
    }

    private isActiveReviewComment(
        comment: PullRequestReviewComment,
        platformType: PlatformType,
    ): boolean {
        if (platformType === PlatformType.GITHUB) {
            return !comment?.isResolved && !comment?.isOutdated;
        }

        return !comment?.isResolved;
    }

    private getReviewCommentMatchId(
        comment: PullRequestReviewComment,
        platformType: PlatformType,
    ): string | null {
        if (platformType === PlatformType.GITHUB) {
            return comment?.fullDatabaseId != null
                ? String(comment.fullDatabaseId)
                : comment?.id != null
                  ? String(comment.id)
                  : null;
        }

        if (platformType === PlatformType.AZURE_REPOS) {
            return comment?.threadId != null ? String(comment.threadId) : null;
        }

        return comment?.id != null ? String(comment.id) : null;
    }
}
