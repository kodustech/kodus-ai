import { createLogger } from '@kodus/flow';
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
} from '../domain/decision';
import type { FeatureKey } from '../domain/feature-keys';
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

/**
 * NestJS adapter around the pure `evaluateCatalogGate` decision in
 * `libs/feature-gate/domain/decision.ts`. Loads the snapshot, decides
 * cloud vs self-hosted from `environment.API_CLOUD_MODE`, then either
 * delegates to PostHog (cloud) or short-circuits (self-hosted).
 *
 * The web mirror at `apps/web/src/core/feature-gate/resolver.ts` calls
 * the same `evaluateCatalogGate` — there's exactly one source of gate
 * logic, even though the runtime adapters differ.
 */
@Injectable()
export class FeatureGateService {
    private readonly logger = createLogger(FeatureGateService.name);
    private readonly snapshot: FeaturesSnapshot;
    private readonly betaFeaturesEnabled: boolean;

    constructor(
        @Inject(POSTHOG_PROVIDER_TOKEN)
        private readonly posthog: IPostHogProvider,
    ) {
        this.snapshot = loadSnapshot();
        this.betaFeaturesEnabled = process.env.BETA_FEATURES === 'true';
    }

    async isEnabled(
        feature: FeatureKey,
        ctx: FeatureCheckContext,
    ): Promise<boolean> {
        const entry = this.snapshot.features[feature];
        const audience = environment.API_CLOUD_MODE ? 'cloud' : 'self-hosted';
        const decision = evaluateCatalogGate({
            entry,
            audience,
            track: ctx.releaseTrack,
            selfHostedBetaEnabled: this.betaFeaturesEnabled,
        });

        if (decision === 'deny') return false;

        if (audience === 'self-hosted') {
            return true; // pass or compat-pass: catalog already gated us.
        }

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
