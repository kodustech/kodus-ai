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
 *   `pass`        — catalog allows. Cloud beta needs no further flag;
 *                   other cloud stages may consult PostHog.
 *   `compat-pass` — feature is missing from the catalog (legacy / in-flight
 *                   feature without an entry yet). Cloud should still hit
 *                   PostHog; self-hosted returns true. On PostHog error,
 *                   cloud falls back to true (legacy permissive behavior).
 */
export type GateDecision = 'deny' | 'pass' | 'compat-pass';

/**
 * Reads the `BETA_FEATURES` env var: the self-hosted opt-in for `beta`-stage
 * features (cloud uses the per-org release track instead).
 *
 * Every reader goes through this one parser - the NestJS service, the Next.js
 * resolver and `scripts/feature-gate/check-gate.ts` - so the operator-facing
 * report cannot print a decision the runtime never takes (#2425). `true` is
 * the documented encoding (`.env.schema`, `release/README.md`) and `1` is
 * accepted because the checker has always taken it; case and surrounding
 * whitespace are ignored, the way `libs/ee/configs/environment` parses its
 * own booleans. Anything else keeps betas off.
 */
export function isBetaFeaturesEnabled(value?: string | null): boolean {
    const normalised = (value ?? '').trim().toLowerCase();
    return normalised === 'true' || normalised === '1';
}

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
 * permissive behavior for stages that still consult PostHog: features
 * missing from the catalog default to on, GA stays on, alpha is denied.
 */
export function cloudFallbackOnPosthogError(
    decision: GateDecision,
    entry: SnapshotFeature | undefined,
): boolean {
    if (decision === 'compat-pass') return true;
    if (decision === 'deny') return false;
    return entry?.stage === 'general-availability';
}
