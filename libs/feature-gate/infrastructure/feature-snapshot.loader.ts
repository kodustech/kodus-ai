import type {
    FeaturesSnapshot,
    SnapshotFeature,
} from '../domain/snapshot.types';
import { FEATURES_SNAPSHOT } from './features-snapshot.generated';

/**
 * Returns the feature catalog from the generated TS mirror of
 * `release/features-snapshot.json`, so it ships inside the webpack bundle.
 * The API/worker images copy `dist/` but not `release/`: reading the JSON
 * from disk found nothing there, every feature came back as missing from
 * the catalog, and cloud fell through to PostHog for all of them.
 */
export function loadSnapshot(): FeaturesSnapshot {
    return FEATURES_SNAPSHOT;
}

export function findFeature(
    snapshot: FeaturesSnapshot,
    flagKey: string,
): SnapshotFeature | undefined {
    return snapshot.features[flagKey];
}
