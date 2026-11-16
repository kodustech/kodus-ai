import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { environment } from '@libs/ee/configs/environment/environment';
import {
    FeatureEvaluationContext,
    IPostHogProvider,
    POSTHOG_PROVIDER_TOKEN,
} from '@libs/telemetry/infrastructure/providers/posthog.provider';

import {
    cloudFallbackOnPosthogError,
    evaluateCatalogGate,
    isBetaFeaturesEnabled,
} from '../domain/decision';
import { FEATURE_KEYS, type FeatureKey } from '../domain/feature-keys';
import type { ReleaseTrack } from '../domain/release-track';
import type { FeaturesSnapshot } from '../domain/snapshot.types';
import { loadSnapshot } from '../infrastructure/feature-snapshot.loader';

export interface FeatureCheckContext {
    /** Distinct id used by PostHog (typically userId or orgId). */
    identifier: string;
    organizationAndTeamData: OrganizationAndTeamData;
    /**
     * Extra group keys routed to PostHog `groups`, beyond the always-set
     * `organization`. One id per group type — callers loop to evaluate
     * multiple values (e.g. one call per touched directory).
     */
    groups?: Record<string, string | undefined>;
    /**
     * The org's release track. Used in cloud to gate beta / alpha
     * features before the PostHog flag check. When omitted, defaults to
     * `beta` (legacy permissive behavior). Pass the org's actual track
     * to enforce stable-customer protection.
     */
    releaseTrack?: ReleaseTrack;
}

export const FEATURE_GATE_SERVICE_TOKEN = Symbol.for(
    'FEATURE_GATE_SERVICE_TOKEN',
);

export interface IFeatureGateService {
    isEnabled(feature: FeatureKey, ctx: FeatureCheckContext): Promise<boolean>;
}

/**
 * NestJS adapter around the pure `evaluateCatalogGate` decision in
 * `libs/feature-gate/domain/decision.ts`. Loads the snapshot, decides
 * cloud vs self-hosted from `environment.API_CLOUD_MODE`, then either
 * uses the release track for cloud beta, PostHog for cloud alpha/GA/legacy,
 * and the catalog plus BETA_FEATURES for self-hosted.
 *
 * The web mirror at `apps/web/src/core/feature-gate/resolver.ts` calls
 * the same `evaluateCatalogGate` — there's exactly one source of gate
 * logic, even though the runtime adapters differ.
 */
@Injectable()
export class FeatureGateService implements IFeatureGateService {
    private readonly logger = createLogger(FeatureGateService.name);
    private readonly snapshot: FeaturesSnapshot;

    constructor(
        @Inject(POSTHOG_PROVIDER_TOKEN)
        private readonly posthog: IPostHogProvider,
    ) {
        this.snapshot = loadSnapshot();
    }

    async isEnabled(
        feature: FeatureKey,
        ctx: FeatureCheckContext,
    ): Promise<boolean> {
        const entry = this.snapshot.features[feature];
        const audience = environment.API_CLOUD_MODE ? 'cloud' : 'self-hosted';
        const releaseTrackBeta = feature === FEATURE_KEYS.conditionalPrApproval;
        const decision = evaluateCatalogGate({
            entry,
            audience,
            track:
                entry?.stage === 'beta' && !releaseTrackBeta
                    ? 'beta'
                    : ctx.releaseTrack,
            // Self-hosted beta stays behind BETA_FEATURES whatever the
            // feature: the release track only decides CLOUD beta, since the
            // `track` input is ignored for a self-hosted audience. Reading
            // `true` for any other beta turned every self-hosted beta on
            // without the env (#2425). Read per call, through the same parser
            // as the web mirror, so the value cannot be frozen at
            // construction while the resolver sees the live one.
            selfHostedBetaEnabled: isBetaFeaturesEnabled(
                process.env.BETA_FEATURES,
            ),
        });

        if (decision === 'deny') return false;

        if (audience === 'self-hosted') {
            return true; // pass or compat-pass: catalog already gated us.
        }

        // Beta is controlled by the release track in the catalog. PostHog
        // remains available for private alpha and legacy rollout flags.
        if (entry?.stage === 'beta' && releaseTrackBeta) return true;

        const evaluationContext: FeatureEvaluationContext | undefined =
            ctx.groups ? { groups: ctx.groups } : undefined;

        try {
            return await this.posthog.isFeatureEnabled(
                feature,
                ctx.identifier,
                ctx.organizationAndTeamData,
                evaluationContext,
            );
        } catch (err) {
            this.logger.warn({
                message: `PostHog feature flag check failed for "${feature}", falling back to snapshot`,
                context: FeatureGateService.name,
                metadata: {
                    feature,
                    error: err instanceof Error ? err.message : String(err),
                },
            });
            return cloudFallbackOnPosthogError(decision, entry);
        }
    }
}
