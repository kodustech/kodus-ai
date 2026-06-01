import { readFileSync } from 'fs';
import { resolve } from 'path';

import type {
    FeaturesSnapshot,
    SnapshotFeature,
} from '../domain/snapshot.types';

const DEFAULT_SNAPSHOT_PATH = resolve(
    __dirname,
    '../../../release/features-snapshot.json',
);

const EMPTY_SNAPSHOT: FeaturesSnapshot = {
    schema_version: 1,
    generated_at: '1970-01-01T00:00:00.000Z',
    source: 'manual',
    features: {},
};

export interface SnapshotLoaderOptions {
    /** Override the path. Defaults to release/features-snapshot.json at repo root. */
    path?: string;
}

/**
 * Loads the feature snapshot from disk once. If the file is missing or
 * malformed, falls back to an empty snapshot (compat: no gating until
 * features are backfilled).
 */
export function loadSnapshot(
    options: SnapshotLoaderOptions = {},
): FeaturesSnapshot {
    const path = options.path ?? DEFAULT_SNAPSHOT_PATH;

    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as FeaturesSnapshot;
        if (parsed.schema_version !== 1) {
            return EMPTY_SNAPSHOT;
        }
        return parsed;
    } catch {
        return EMPTY_SNAPSHOT;
    }
}

export function findFeature(
    snapshot: FeaturesSnapshot,
    flagKey: string,
): SnapshotFeature | undefined {
    return snapshot.features[flagKey];
}
