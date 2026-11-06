import type { ReviewMode } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/** The mode a review command asks for (`--balanced` / `--heavy`), over the
 *  mode set in settings. */
export type RequestedReviewMode = 'balanced' | 'heavy';

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
