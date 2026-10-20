import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

/**
 * A finding's severity on the review's scale. A model can answer outside it
 * ("major", "blocker"); the review reads anything it does not know as medium,
 * so ranking, the severity floor and the comment all see one of the four.
 */
export function normalizeSuggestionSeverity(severity?: string): SeverityLevel {
    switch ((severity || '').toLowerCase()) {
        case SeverityLevel.CRITICAL:
            return SeverityLevel.CRITICAL;
        case SeverityLevel.HIGH:
            return SeverityLevel.HIGH;
        case SeverityLevel.LOW:
            return SeverityLevel.LOW;
        default:
            return SeverityLevel.MEDIUM;
    }
}
