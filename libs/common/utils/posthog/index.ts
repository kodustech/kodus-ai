/**
 * @deprecated Replaced by `FeatureGateService` (libs/feature-gate) and the
 * `isFeatureEnabled` method on `PostHogProvider` (libs/telemetry). This
 * module is left as a tombstone only because a few legacy test files still
 * import it via `jest.mock`. New code must use `FeatureGateService`.
 */
export const FEATURE_FLAGS = {} as const;

/** @deprecated See file header. */
export default {
    isInitialized: false,
    isFeatureEnabled: async (): Promise<boolean> => true,
};
