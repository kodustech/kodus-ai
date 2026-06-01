import { BYOKConfig } from '@kodus/kodus-common/llm';
import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    DocumentationContextItem,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    CodeReviewConfig,
    CodeReviewVersion,
    CodeSuggestion,
    CommentResult,
    GroupingModeSuggestions,
    LimitationType,
    ReviewModeResponse,
    ReviewOptions,
    SuggestionControlConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

/**
 * Contract for the service that handles code suggestions lifecycle,
 * including validation, filtering, and prioritization.
 */
export interface ISuggestionService {
    /**
     * Validates if suggestions have been implemented by analyzing code patches
     */
    validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        codePatch: string,
        savedSuggestions: Partial<CodeSuggestion>[],
        prNumber?: number,
    ): Promise<any>;

    /**
     * Removes suggestions related to files that already have saved suggestions
     */
    removeSuggestionsRelatedToSavedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: string,
        savedSuggestions: Partial<CodeSuggestion>[],
        newSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Filters suggestions by review options configured by the user
     */
    filterCodeSuggestionsByReviewOptions(
        config: ReviewOptions,
        codeReviewComments: any,
    ): any;

    /**
     * Filters suggestions based on code diff to ensure relevance
     */
    filterSuggestionsCodeDiff(
        patchWithLinesStr: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[];

    /**
     * Applies a safeguard filter to remove invalid suggestions
     */
    filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        relevantContent: string,
        codeDiff: string,
        suggestions: Partial<CodeSuggestion>[],
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
    ): Promise<any>;

    /**
     * Prioritizes suggestions based on severity level
     */
    processSeverityFilter(
        suggestions: Partial<CodeSuggestion>[],
        severityLevelFilter: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<{
        prioritizedBySeverity: Partial<CodeSuggestion>[];
        discardedBySeverity: Partial<CodeSuggestion>[];
    }>;

    /**
     * Prioritizes suggestions by limiting the number per file
     */
    prioritizeSuggestionsByFile(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        limitPerFile: number,
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Prioritizes suggestions across an entire PR
     */
    prioritizeSuggestionsByPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        prLimit: number,
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Prioritizes suggestions based on quantity limits
     */
    prioritizeByQuantity(
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
    ): Promise<Partial<CodeSuggestion>[]>;

    prioritizeSuggestionsBySeverityLimits(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        severityLimits: {
            low: number;
            medium: number;
            high: number;
            critical: number;
        },
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Gets suggestions discarded during quantity filtering
     */
    getDiscardedByQuantity(
        beforeQuantityFilter: Partial<CodeSuggestion>[],
        afterQuantityFilter: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[];

    /**
     * Gets suggestions discarded during any filtering process
     */
    getDiscardedSuggestions(
        allSuggestions: Partial<CodeSuggestion>[],
        filteredSuggestions: Partial<CodeSuggestion>[],
        discardReason: PriorityStatus,
    ): Partial<CodeSuggestion>[];

    /**
     * Analyzes and assigns severity levels to code suggestions
     */
    analyzeSuggestionsSeverity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: Partial<CodeSuggestion>[],
        selectedCategories: ReviewOptions,
        codeReviewVersion?: CodeReviewVersion,
        byokConfig?: BYOKConfig,
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Main method to prioritize suggestions based on configured rules
     */
    prioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
        byokConfig?: BYOKConfig,
    ): Promise<{
        prioritizedSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestionsBySeverityOrQuantity: Partial<CodeSuggestion>[];
    }>;

    /**
     * Sorts and prioritizes suggestions for a PR
     */
    sortAndPrioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfig: CodeReviewConfig,
        pullRequest: { number: number },
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
    ): Promise<{
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[];
        allDiscardedSuggestions: Partial<CodeSuggestion>[];
    }>;

    /**
     * Normalizes suggestion labels to handle variations
     */
    normalizeLabel(label: string): string;

    /**
     * Filters suggestion properties to prepare for analysis
     */
    filterSuggestionProperties(suggestions: Partial<CodeSuggestion>[]): any[];

    /**
     * Filters suggestions by severity level
     */
    filterSuggestionsBySeverityLevel(
        suggestions: any[],
        severityLevelFilter: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<any[]>;

    /**
     * Sorts suggestions by file path and severity
     */
    sortSuggestionsByFilePathAndSeverity(
        suggestions: CodeSuggestion[],
        groupingMode: GroupingModeSuggestions,
    ): any[];

    /**
     * Sorts suggestions by calculated priority score
     */
    sortSuggestionsByPriority(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestions: any[],
    ): any[];

    /**
     * Calculates a priority score for a suggestion based on category and severity
     */
    calculateSuggestionRankScore(
        suggestion: Partial<CodeSuggestion>,
    ): Promise<number>;

    /**
     * Verifies which suggestions were sent as comments and updates their status
     */
    verifyIfSuggestionsWereSent(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[],
        commentResults: CommentResult[],
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Extracts repriorized suggestions from comment results and removes them from discarded suggestions.
     * This prevents duplicate saves when a fallback suggestion replaces a failed prioritized suggestion.
     */
    extractRepriorizedSuggestions(
        commentResults: CommentResult[],
        discardedSuggestions: Partial<CodeSuggestion>[],
    ): {
        repriorizedSuggestions: Partial<CodeSuggestion>[];
        filteredDiscardedSuggestions: Partial<CodeSuggestion>[];
    };

    /**
     * Transforms comment results to PR level suggestions
     */
    transformCommentResultsToPrLevelSuggestions(
        commentResults: CommentResult[],
    ): ISuggestionByPR[];

    /**
     * Filters persisted review suggestions to only those whose provider comments
     * are still active in the current review iteration.
     */
    filterActiveReviewSuggestions<
        T extends { comment?: { id?: number | string } },
    >(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
        suggestions: T[];
    }): Promise<T[]>;

    /**
     * Resolves comments on the platform (GitHub, etc.) for implemented suggestions
     */
    resolveImplementedSuggestionsOnPlatform(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
        dryRun?: CodeReviewPipelineContext['dryRun'];
    }): Promise<void>;
}

export const SUGGESTION_SERVICE_TOKEN = 'SUGGESTION_SERVICE_TOKEN';
