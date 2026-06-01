export { FeatureGateService } from './application/feature-gate.service';
export type { FeatureCheckContext } from './application/feature-gate.service';
export { FeatureGateModule } from './modules/feature-gate.module';
export {
    FEATURE_KEYS,
    ALL_FEATURE_KEYS,
    isFeatureKey,
} from './domain/feature-keys';
export type { FeatureKey } from './domain/feature-keys';
export type {
    FeatureStage,
    FeatureAudience,
    FeaturesSnapshot,
    SnapshotFeature,
} from './domain/snapshot.types';
export {
    RELEASE_TRACKS,
    DEFAULT_RELEASE_TRACK,
    isReleaseTrack,
    trackPermitsStage,
} from './domain/release-track';
export type { ReleaseTrack } from './domain/release-track';
export {
    evaluateCatalogGate,
    cloudFallbackOnPosthogError,
} from './domain/decision';
export type { GateDecision, GateInputs } from './domain/decision';
export { loadSnapshot } from './infrastructure/feature-snapshot.loader';
