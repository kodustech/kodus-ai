import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/** Public decisions never echo parser output or saved private instructions. */
export const REVIEW_SETTINGS_HOLD_REASON =
    'Risk or approval settings are invalid. Check your configuration.';

const reviewSettingsKeys = [
    'approvalPolicies',
    'approvalLabels',
    'approvalAuthors',
    'approvalSensitivePaths',
    'approvalRiskActive',
    'approvalRiskInstructions',
    'riskAssessmentActive',
    'riskCriteria',
    'riskReviewRouting',
] as const;

/** Keep code review available without allowing invalid policy data to approve. */
export function unavailableReviewSettings<T extends object>(
    source: T,
    reason: string,
) {
    const safe = { ...source } as T & Partial<CodeReviewConfig>;
    for (const key of reviewSettingsKeys) delete safe[key];
    safe.reviewSettingsError = reason;
    return safe;
}
