import type { ReviewMode } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { RiskReviewRouting } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { RiskAssessmentResult } from './risk/risk-assessment';

/** The mode a review command asks for (`--balanced` / `--heavy` /
 *  `--ultra`), over the mode set in settings. */
export type RequestedReviewMode = 'balanced' | 'heavy' | 'ultra';

/** Resolve before model selection. Commands win; unavailable risk uses settings. */
export function resolveRiskReviewMode(input: {
    requested?: RequestedReviewMode;
    configured?: ReviewMode;
    routing?: RiskReviewRouting;
    risk?: RiskAssessmentResult;
    currentHeadSha: string;
    heavyAllowed: boolean;
}): ReviewMode {
    // Preserve the CLI's separate fast mode and the legacy deep mode.
    if (input.configured === 'fast') return 'fast';
    let mode: ReviewMode = input.requested ?? input.configured ?? 'balanced';
    if (
        !input.requested &&
        input.risk?.status === 'assessed' &&
        !!input.currentHeadSha &&
        input.risk.snapshot.headSha === input.currentHeadSha
    ) {
        mode = input.risk.riskIdentified
            ? (input.routing?.riskFound ?? 'heavy')
            : (input.routing?.noRisk ?? 'balanced');
    }
    return mode === 'heavy' && !input.heavyAllowed ? 'balanced' : mode;
}

/**
 * Whether a review runs heavy: the mode the command asked for, else the mode
 * set in settings. A `fast` review never runs heavy. Ultra is not heavy here:
 * its runs route their own models (libs/ee/ultra-review).
 */
export function isHeavyReview(
    requested: RequestedReviewMode | undefined,
    configured: ReviewMode | undefined,
): boolean {
    if (configured === 'fast') return false;
    return (requested ?? configured) === 'heavy';
}

/** Whether a review asks for Ultra: the command's mode, else the settings'. */
export function isUltraReview(
    requested: RequestedReviewMode | undefined,
    configured: ReviewMode | undefined,
): boolean {
    if (configured === 'fast') return false;
    return (requested ?? configured) === 'ultra';
}

/**
 * The mode the review agents run in. A heavy review runs them as a balanced
 * one; its lenses are switched on by `heavy`. A legacy `normal` reads as
 * `balanced`.
 */
export function agentReviewMode(
    configured: ReviewMode | 'normal' | undefined,
): 'fast' | 'balanced' | 'deep' {
    return configured === 'fast' || configured === 'deep'
        ? configured
        : 'balanced';
}

/**
 * The mode a review execution ran in, as the Pull Requests screen shows it.
 * Undefined for an execution that reviewed nothing (skipped, failed before the
 * review). An execution recorded before the mode was stored reads `heavy`, and
 * one older than that reads as balanced.
 */
export function reviewModeOfExecution(
    dataExecution: Record<string, any> | null | undefined,
): RequestedReviewMode | undefined {
    const reviewed =
        !!dataExecution?.lastAnalyzedCommit &&
        typeof dataExecution.lastAnalyzedCommit === 'object' &&
        Object.keys(dataExecution.lastAnalyzedCommit).length > 0;
    if (!reviewed) return undefined;
    if (
        dataExecution.reviewMode === 'heavy' ||
        dataExecution.reviewMode === 'balanced' ||
        dataExecution.reviewMode === 'ultra'
    ) {
        return dataExecution.reviewMode;
    }
    return dataExecution.heavy === true ? 'heavy' : 'balanced';
}

/**
 * The mode the last review of a PR ran in, for a command asking another one:
 * the stored mode, else `heavy` from the older flag, else `balanced`. Unlike
 * reviewModeOfExecution, an execution that reviewed nothing still answers.
 */
export function lastReviewModeOf(
    dataExecution: Record<string, any> | null | undefined,
): RequestedReviewMode {
    const mode = dataExecution?.reviewMode;
    if (mode === 'heavy' || mode === 'balanced' || mode === 'ultra') {
        return mode;
    }
    return dataExecution?.heavy === true ? 'heavy' : 'balanced';
}
