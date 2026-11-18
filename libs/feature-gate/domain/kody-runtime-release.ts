import { isReleaseTrack, trackPermitsStage } from './release-track';
import type { FeatureStage } from './snapshot.types';

/**
 * Kody Runtime's stage. The `kody-runtime` catalog entry documents it; this
 * is the one place the Runtime decision reads it.
 */
export const KODY_RUNTIME_STAGE: FeatureStage = 'alpha';

/**
 * Whether Kody Runtime is released to an org on `track`: only the org's
 * stored release track decides, the same in cloud and self-hosted, with no
 * flag service. The API gate and the web layout both ask this, so they
 * cannot disagree. A missing or unknown track is a no.
 */
export function isKodyRuntimeReleasedToTrack(track: unknown): boolean {
    return (
        typeof track === 'string' &&
        isReleaseTrack(track) &&
        trackPermitsStage(track, KODY_RUNTIME_STAGE)
    );
}
