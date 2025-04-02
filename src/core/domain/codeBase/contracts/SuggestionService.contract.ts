import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    CodeSuggestion,
    SuggestionControlConfig,
    CodeReviewConfig,
    LimitationType,
    GroupingModeSuggestions,
    ReviewOptions,
    ReviewModeResponse,
    CommentResult,
} from '@/config/types/general/codeReview.type';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';

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
        codeDiff: string,
        suggestions: Partial<CodeSuggestion>[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
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
    ): Promise<Partial<CodeSuggestion>[]>;

    /**
     * Main method to prioritize suggestions based on configured rules
     */
    prioritizeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        suggestionControl: SuggestionControlConfig,
        prNumber: number,
        suggestions: Partial<CodeSuggestion>[],
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
}

export const SUGGESTION_SERVICE_TOKEN = 'SUGGESTION_SERVICE_TOKEN';
