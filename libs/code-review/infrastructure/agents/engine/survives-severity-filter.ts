import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Whether a suggestion clears the team's severity threshold.
 *
 * Two kinds bypass it. Kody Rules, because a team-defined rule is an explicit
 * instruction and always surfaces unless the team opts in to filtering them.
 * And deterministic findings, because they are opted into per tool, publish as
 * one comment per category, and the review prompt tells the agent not to
 * restate them — so the threshold would not be reducing noise, it would be
 * deleting the only copy of a scanner-proven fact from the review.
 */
export function survivesSeverityFilter(
    suggestion: Partial<CodeSuggestion>,
    acceptedSeverities: string[],
    applyFiltersToKodyRules: boolean,
): boolean {
    if (isAnalyzerSuggestion(suggestion)) {
        return true;
    }

    if (suggestion.label === 'kody_rules' && !applyFiltersToKodyRules) {
        return true;
    }

    return acceptedSeverities.includes(
        (suggestion.severity || 'medium').toLowerCase(),
    );
}
