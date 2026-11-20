import type { RequestedReviewMode } from './review-mode';

/**
 * The organization's switches for review modes asked by a PR command
 * (`--heavy`, `--ultra`). Missing, or a switch missing, leaves the command
 * on. Reviews that settings route to Heavy or Ultra are not affected.
 */
export type ReviewCommandModesConfig = {
    heavyBlocked?: boolean;
    ultraBlocked?: boolean;
};

export type BlockableCommandMode = 'heavy' | 'ultra';

/** The mode a command asked for when the organization turned it off. */
export function blockedCommandMode(
    requested: RequestedReviewMode | undefined,
    config: ReviewCommandModesConfig | null | undefined,
): BlockableCommandMode | undefined {
    if (requested === 'heavy' && config?.heavyBlocked === true) return 'heavy';
    if (requested === 'ultra' && config?.ultraBlocked === true) return 'ultra';
    return undefined;
}

export function reviewCommandBlockedMessage(
    mode: BlockableCommandMode,
): string {
    const name = mode === 'heavy' ? 'Heavy' : 'Ultra';
    return `${name} review by command is turned off for this organization, so this pull request was not reviewed. An organization owner can turn it on in General settings.`;
}
