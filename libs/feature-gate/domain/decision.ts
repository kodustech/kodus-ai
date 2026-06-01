import {
    DEFAULT_RELEASE_TRACK,
    trackPermitsStage,
    type ReleaseTrack,
} from './release-track';
import type { FeatureAudience, SnapshotFeature } from './snapshot.types';

/**
 * Outcome of the deterministic catalog gate. Adapters use this to decide
 * whether to short-circuit, consult PostHog, or apply a runtime fallback.
 *
 *   `deny`        — the catalog explicitly blocks the feature for this
 *                   audience / track combination. Adapter returns false.
 *   `pass`        — catalog allows. Cloud adapter should consult PostHog
 *                   for operational fine-tuning; self-hosted returns true.
 *   `compat-pass` — feature is missing from the catalog (legacy / in-flight
 *                   feature without an entry yet). Cloud should still hit
 *                   PostHog; self-hosted returns true. On PostHog error,
 *                   cloud falls back to true (legacy permissive behavior).
 */
export type GateDecision = 'deny' | 'pass' | 'compat-pass';

export interface GateInputs {
    entry: SnapshotFeature | undefined;
    audience: FeatureAudience;
    /** Org's release track. Cloud only — ignored on self-hosted. */
    track?: ReleaseTrack;
    /** BETA_FEATURES env var. Self-hosted only — ignored on cloud. */
    selfHostedBetaEnabled?: boolean;
}

/**
 * Pure deterministic decision based on catalog state + caller context.
 * No I/O, no PostHog, no env reads — adapters supply the inputs.
 *
 * This is the SINGLE source of feature-gate logic. Both the NestJS
 * service (api/worker/webhooks) and the Next.js resolver (web) call it
 * with their own runtime adapters around it.
 */
export function evaluateCatalogGate(inputs: GateInputs): GateDecision {
    const { entry, audience, track, selfHostedBetaEnabled } = inputs;

    if (!entry) return 'compat-pass';

    if (
        entry.audience &&
        entry.audience.length > 0 &&
        !entry.audience.includes(audience)
    ) {
        return 'deny';
    }

    if (audience === 'self-hosted') {
        switch (entry.stage) {
            case 'general-availability':
                return 'pass';
            case 'beta':
                return selfHostedBetaEnabled ? 'pass' : 'deny';
            case 'alpha':
            default:
                return 'deny';
        }
    }

    const effectiveTrack = track ?? DEFAULT_RELEASE_TRACK;
    return trackPermitsStage(effectiveTrack, entry.stage) ? 'pass' : 'deny';
}

/**
 * Cloud fallback when PostHog is unreachable. Mirrors the historical
 * permissive behavior: features missing from the catalog default to on,
 * GA features stay on, anything else is denied.
 */
export function cloudFallbackOnPosthogError(
    decision: GateDecision,
    entry: SnapshotFeature | undefined,
): boolean {
    if (decision === 'compat-pass') return true;
    if (decision === 'deny') return false;
    return entry?.stage === 'general-availability';
}
