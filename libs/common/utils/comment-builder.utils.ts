import {
    CodeSuggestion,
    Comment,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * A suggestion's line range as it should reach a provider: `start` <= `end`.
 *
 * Agents sometimes emit the pair the other way round (`relevantLinesStart: 30`
 * with `relevantLinesEnd: 19`). GitHub rejects a reversed range on its own
 * ("start_line must be less than line" style validation), and the 422 does not
 * say which end is wrong, so the finding was lost instead of being anchored to
 * the lines it actually covers. Both ends are real, only their order is not:
 * swap them.
 */
function normalizeLines(suggestion: Partial<CodeSuggestion>): {
    start?: number;
    end?: number;
} {
    const start = suggestion.relevantLinesStart;
    const end = suggestion.relevantLinesEnd;

    if (typeof start === 'number' && typeof end === 'number' && start > end) {
        return { start: end, end: start };
    }

    return { start, end };
}

/**
 * Calculates the start line for a review comment based on suggestion lines.
 * Returns undefined if start equals end or if range is too large (>15 lines).
 */
export function calculateCommentStartLine(
    suggestion: Partial<CodeSuggestion>,
): number | undefined {
    const { start, end } = normalizeLines(suggestion);

    if (start === undefined || start === end) {
        return undefined;
    }
    return start + 15 > end ? start : undefined;
}

/**
 * Calculates the end line for a review comment based on suggestion lines.
 * If range is too large (>15 lines), returns start line instead.
 */
export function calculateCommentEndLine(
    suggestion: Partial<CodeSuggestion>,
): number | undefined {
    const { start, end } = normalizeLines(suggestion);

    if (start === undefined || start === end) {
        return end;
    }
    return start + 15 > end ? end : start;
}

/**
 * Builds a Comment object from a CodeSuggestion for use in review comment creation.
 */
export function buildCommentFromSuggestion(
    suggestion: Partial<CodeSuggestion>,
    repositoryLanguage: string,
): Comment {
    return {
        path: suggestion.relevantFile,
        body: {
            language: repositoryLanguage,
            improvedCode: suggestion.improvedCode,
            suggestionContent: suggestion.suggestionContent,
            actionStatement:
                suggestion.clusteringInformation?.actionStatement || '',
        },
        start_line: calculateCommentStartLine(suggestion),
        line: calculateCommentEndLine(suggestion),
        side: 'RIGHT',
        suggestion: suggestion as CodeSuggestion,
    };
}
