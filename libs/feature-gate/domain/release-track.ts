import type { FeatureStage } from './snapshot.types';

export const RELEASE_TRACKS = ['stable', 'beta', 'alpha'] as const;
export type ReleaseTrack = (typeof RELEASE_TRACKS)[number];

export const DEFAULT_RELEASE_TRACK: ReleaseTrack = 'beta';

export function isReleaseTrack(value: string): value is ReleaseTrack {
    return (RELEASE_TRACKS as readonly string[]).includes(value);
}

const TRACK_RANK: Record<ReleaseTrack, number> = {
    stable: 0,
    beta: 1,
    alpha: 2,
};

/**
 * Minimum track required to receive a feature at the given stage.
 *
 * Cumulative model: `alpha` track sees alpha + beta + ga, `beta` track
 * sees beta + ga, `stable` track sees only ga.
 */
const STAGE_REQUIRED_RANK: Record<FeatureStage, number> = {
    alpha: TRACK_RANK.alpha,
    beta: TRACK_RANK.beta,
    'general-availability': TRACK_RANK.stable,
};

export function trackPermitsStage(
    track: ReleaseTrack,
    stage: FeatureStage,
): boolean {
    return TRACK_RANK[track] >= STAGE_REQUIRED_RANK[stage];
}
