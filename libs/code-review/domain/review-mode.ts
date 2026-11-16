import type { ReviewMode } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { RiskReviewRouting } from '@libs/core/infrastructure/config/types/general/risk-assessment';
import type { RiskAssessmentResult } from './risk/risk-assessment';

/** The mode a review command asks for (`--balanced` / `--heavy`), over the
 *  mode set in settings. */
export type RequestedReviewMode = 'balanced' | 'heavy';

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
 * set in settings. A `fast` review never runs heavy.
 */
export function isHeavyReview(
    requested: RequestedReviewMode | undefined,
    configured: ReviewMode | undefined,
): boolean {
    if (configured === 'fast') return false;
    return (requested ?? configured) === 'heavy';
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
