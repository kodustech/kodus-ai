import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

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
