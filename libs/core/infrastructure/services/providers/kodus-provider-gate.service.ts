import { Inject, Injectable, Optional } from '@nestjs/common';

import { FEATURE_KEYS, FeatureGateService } from '@libs/feature-gate';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { isKodusProviderAvailable } from './kodus-provider-availability';

/**
 * Per-org gate for the `kodus` BYOK provider ("Kodus as the provider").
 *
 * Two layers, both required:
 *   1. deployment — cloud only (`isKodusProviderAvailable`, compiled-in);
 *   2. rollout — the `kodus-provider` feature in the catalog is at stage
 *      `alpha`, so an org must be on the alpha release track AND be
 *      allow-listed on the PostHog flag's release conditions. That is where
 *      the private-alpha list lives (Kodus's own org, ClickBus, …) — never
 *      customer ids in the repo.
 *
 * Every org-facing surface asks this one service: the provider picker, the
 * model listing, the connection probe and the save. A slot an org already
 * saved keeps routing (the runtime never asks) — flipping the flag off stops
 * new connections, not reviews mid-flight.
 */
/** Env allow-list for the alpha: `*` or comma-separated organization ids. */
export const KODUS_PROVIDER_ALPHA_ORGS_ENV = 'API_KODUS_PROVIDER_ALPHA_ORGS';

export function parseAlphaOrgs(raw: string | undefined): '*' | Set<string> {
    const value = (raw ?? '').trim();
    if (value === '*') return '*';
    return new Set(
        value
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
    );
}

/** DI token: consumers inject the token, the class stays the type. */
export const KODUS_PROVIDER_GATE_TOKEN = Symbol.for('KodusProviderGate');

@Injectable()
export class KodusProviderGate {
    private readonly logger = createLogger(KodusProviderGate.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        // Optional so a module that lacks the organization service still
        // boots; without it the release track is unknown, which the catalog
        // treats as `beta` — an alpha feature is then denied (fail closed).
        @Optional()
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService?: IOrganizationService,
    ) {}

    /** Whether `organizationId` may connect the Kodus provider right now. */
    async isEnabledFor(organizationId: string | undefined): Promise<boolean> {
        if (!isKodusProviderAvailable()) return false;
        if (!organizationId) return false;
        // Ops/e2e allow-list ahead of PostHog: `*` opens the alpha to every
        // org on this deployment (dev VMs, e2e), a list of org ids pins it
        // (a fallback when PostHog is unreachable). Unset in production.
        const allow = parseAlphaOrgs(process.env[KODUS_PROVIDER_ALPHA_ORGS_ENV]);
        if (allow === '*' || allow.has(organizationId)) return true;
        try {
            const releaseTrack = this.organizationService
                ? await this.organizationService.getReleaseTrack(organizationId)
                : undefined;
            return await this.featureGate.isEnabled(FEATURE_KEYS.kodusProvider, {
                identifier: organizationId,
                organizationAndTeamData: { organizationId },
                releaseTrack,
            });
        } catch (error) {
            this.logger.warn({
                message: 'Kodus provider gate check failed; treating as off',
                context: KodusProviderGate.name,
                metadata: {
                    organizationId,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
            return false;
        }
    }
}

/** The message every refused surface shows — one string, one meaning. */
export const KODUS_PROVIDER_NOT_ENABLED_MESSAGE =
    'The Kodus provider is in private alpha and is not enabled for this organization yet';
