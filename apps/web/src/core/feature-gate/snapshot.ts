import type { SnapshotFeature } from "@libs/feature-gate/domain/snapshot.types";
import { FEATURES_SNAPSHOT } from "@libs/feature-gate/infrastructure/features-snapshot.generated";

/**
 * Web reads the catalog from a generated TypeScript module rather than the
 * JSON sibling at `release/features-snapshot.json`. Next.js's
 * `outputFileTracingRoot` is pinned to `apps/web`, which blocks bundling
 * files outside that directory — direct JSON imports of the repo-root
 * snapshot fail at compile time. The TS mirror lives under `@libs/*`
 * (already aliased) so this stays a pure module import. The lib still
 * reads the JSON via fs at runtime in NestJS where `@libs/*` resolution
 * isn't a concern.
 */

export function getSnapshot() {
    return FEATURES_SNAPSHOT;
}

export function findFeature(flagKey: string): SnapshotFeature | undefined {
    return FEATURES_SNAPSHOT.features[flagKey];
}
