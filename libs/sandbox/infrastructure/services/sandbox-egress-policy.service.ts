import { Inject, Injectable, Optional } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

/**
 * How a sandbox reaches the internet.
 * - `fixed_ip`: through the egress proxy, so it leaves from our fixed IP
 *   (what customers that allowlist us expect). Costs proxy traffic.
 * - `direct`: straight from the sandbox provider's network.
 */
export type EgressRoute = 'fixed_ip' | 'direct';

export interface EgressScope {
    organizationId: string;
    teamId: string;
}

/** Why a direct clone had to fall back to the fixed IP. */
export type FixedIpReason =
    'ip_allow_list' | 'forbidden' | 'unreachable' | 'other';

/** `integration_configs.configValue` for `egress_fixed_ip`. */
export interface EgressFixedIpMarker {
    required: boolean;
    reason?: FixedIpReason;
    source?: 'clone_fallback' | 'manual';
    detectedAt?: string;
}

/**
 * `global_parameters.configValue` for `sandbox_egress`. Absent = nobody
 * leaves direct, which is the behavior before this existed.
 *
 *   { "directOrganizationIds": ["<org uuid>"] }   // rollout to a few orgs
 *   { "directByDefault": true }                   // every org not marked
 */
export interface EgressRollout {
    directByDefault: boolean;
    directOrganizationIds: string[];
}

export interface ISandboxEgressPolicy {
    route(scope: EgressScope | undefined): Promise<EgressRoute>;
    markFixedIpRequired(
        scope: EgressScope,
        reason: FixedIpReason,
    ): Promise<void>;
}

export const SANDBOX_EGRESS_POLICY_TOKEN = Symbol(
    'SANDBOX_EGRESS_POLICY_TOKEN',
);

/** Rollout changes reach every worker within this window. */
const ROLLOUT_TTL_MS = 60_000;
/** A failed rollout read is retried this soon, not after a whole TTL. */
const ROLLOUT_RETRY_MS = 5_000;
/**
 * A team marker read is reused this long, unmarked teams included (most
 * teams never get a marker). A marker written by another worker is seen
 * here within this window; until then a direct clone of that team fails
 * once more and falls back, which costs seconds, never the review.
 */
const MARKER_TTL_MS = 10 * 60_000;

const OFF: EgressRollout = {
    directByDefault: false,
    directOrganizationIds: [],
};

const DAY_MS = 24 * 60 * 60_000;
/**
 * How long a marker the clone fallback wrote holds. A refusal that names
 * the IP (allow list, 403) is strong evidence; an unreachable host or an
 * unreadable error may have been a blip. Past this, the team is tried
 * direct again: a false marker heals itself, a true one is written again
 * after one failed attempt. Manual markers never expire.
 */
export const FIXED_IP_MARKER_TTL_MS: Record<FixedIpReason, number> = {
    ip_allow_list: 30 * DAY_MS,
    forbidden: 30 * DAY_MS,
    unreachable: DAY_MS,
    other: DAY_MS,
};

const markerCacheKey = (scope: EgressScope) =>
    `sandbox-egress:fixed-ip:${scope.organizationId}:${scope.teamId}`;

/**
 * Decides, per team, whether a sandbox needs the fixed egress IP.
 *
 * Every doubt resolves to `fixed_ip`, which is what every sandbox did before:
 * no team to look up, rollout off or unreadable, marker unreadable. A team
 * is marked by the clone fallback (E2BSandboxService) when its direct clone
 * failed and the same clone through the proxy worked, so a marker is proof,
 * not a guess.
 */
@Injectable()
export class SandboxEgressPolicyService implements ISandboxEgressPolicy {
    private readonly logger = createLogger(SandboxEgressPolicyService.name);
    private rollout: EgressRollout = OFF;
    private rolloutReadAt = 0;
    private rolloutRetryAt = 0;
    /**
     * Teams this worker marked, with the order of the mark. A marker read
     * that started before a mark must not cache its older answer over it.
     */
    private readonly markedAt = new Map<string, number>();
    private markSeq = 0;

    constructor(
        @Optional()
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters?: Pick<
            IGlobalParametersService,
            'findByKey'
        >,
        @Optional()
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigs?: Pick<
            IIntegrationConfigService,
            'findOne' | 'createOrUpdateConfig'
        >,
        // Explicit token: a Pick<> type is emitted as `Object` in the
        // constructor metadata, which Nest would never resolve.
        @Optional()
        @Inject(CacheService)
        private readonly cache?: Pick<
            CacheService,
            'getFromCache' | 'addToCache'
        >,
    ) {}

    async route(scope: EgressScope | undefined): Promise<EgressRoute> {
        if (!scope?.organizationId || !scope?.teamId) return 'fixed_ip';
        if (!this.integrationConfigs) return 'fixed_ip';

        const rollout = await this.readRollout();
        if (
            !rollout.directByDefault &&
            !rollout.directOrganizationIds.includes(scope.organizationId)
        ) {
            return 'fixed_ip';
        }

        try {
            return (await this.requiresFixedIp(scope)) ? 'fixed_ip' : 'direct';
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the egress_fixed_ip marker; keeping the fixed IP',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope },
            });
            return 'fixed_ip';
        }
    }

    async markFixedIpRequired(
        scope: EgressScope,
        reason: FixedIpReason,
    ): Promise<void> {
        // This worker stops trying direct for the team first, whatever
        // happens to the write below.
        this.markedAt.set(markerCacheKey(scope), ++this.markSeq);
        await this.cacheMarker(scope, true);

        try {
            if (!this.integrationConfigs) return;
            // The team's code management integration is the one holding its
            // repository list.
            const repositories = await this.integrationConfigs.findOne({
                team: { uuid: scope.teamId },
                configKey: IntegrationConfigKey.REPOSITORIES,
            });
            const integrationId = repositories?.integration?.uuid;
            if (!integrationId) {
                this.logger.warn({
                    message:
                        'No code management integration to hold the egress_fixed_ip marker; this worker keeps the fixed IP for the team',
                    context: SandboxEgressPolicyService.name,
                    metadata: { ...scope, reason },
                });
                return;
            }

            const marker: EgressFixedIpMarker = {
                required: true,
                reason,
                source: 'clone_fallback',
                detectedAt: new Date().toISOString(),
            };
            await this.integrationConfigs.createOrUpdateConfig(
                IntegrationConfigKey.EGRESS_FIXED_IP,
                marker,
                integrationId,
                {
                    organizationId: scope.organizationId,
                    teamId: scope.teamId,
                },
            );
            this.logger.log({
                message: `[egress] team marked as needing the fixed IP (${reason})`,
                context: SandboxEgressPolicyService.name,
                metadata: { ...scope, reason },
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not store the egress_fixed_ip marker; this worker keeps the fixed IP for the team',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope, reason },
            });
        }
    }

    private async requiresFixedIp(scope: EgressScope): Promise<boolean> {
        const key = markerCacheKey(scope);
        const cached = await this.cache
            ?.getFromCache<{ required: boolean }>(key)
            .catch(() => null);
        if (cached && typeof cached.required === 'boolean') {
            return cached.required;
        }

        const readStartedAt = this.markSeq;
        const config = await this.integrationConfigs!.findOne({
            team: { uuid: scope.teamId },
            configKey: IntegrationConfigKey.EGRESS_FIXED_IP,
        });
        // Marked by this worker while the read was in flight: the read saw
        // the database before the mark, and the mark already cached `true`.
        if ((this.markedAt.get(key) ?? 0) > readStartedAt) return true;
        const required = markerHolds(
            config?.configValue as EgressFixedIpMarker | undefined,
            Date.now(),
        );
        await this.cacheMarker(scope, required);
        return required;
    }

    private async cacheMarker(
        scope: EgressScope,
        required: boolean,
    ): Promise<void> {
        await this.cache
            ?.addToCache(markerCacheKey(scope), { required }, MARKER_TTL_MS)
            .catch(() => undefined);
    }

    private async readRollout(): Promise<EgressRollout> {
        if (!this.globalParameters) return OFF;
        const now = Date.now();
        if (this.rolloutReadAt && now - this.rolloutReadAt < ROLLOUT_TTL_MS) {
            return this.rollout;
        }
        if (now < this.rolloutRetryAt) return this.rollout;

        try {
            const param = await this.globalParameters.findByKey(
                GlobalParametersKey.SANDBOX_EGRESS,
            );
            this.rollout = parseEgressRollout(param?.configValue);
            this.rolloutReadAt = now;
        } catch (error) {
            this.rolloutRetryAt = now + ROLLOUT_RETRY_MS;
            this.logger.warn({
                message: this.rolloutReadAt
                    ? 'Could not read the sandbox_egress global parameter; keeping the last known rollout'
                    : 'Could not read the sandbox_egress global parameter yet; every sandbox keeps the fixed IP',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { rollout: this.rollout },
            });
        }
        return this.rollout;
    }
}

export function parseEgressRollout(value: unknown): EgressRollout {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return OFF;
    }
    const v = value as Record<string, unknown>;
    const ids = Array.isArray(v.directOrganizationIds)
        ? v.directOrganizationIds.filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : [];
    return {
        directByDefault: v.directByDefault === true,
        directOrganizationIds: ids,
    };
}

/** Whether a stored marker still sends the team through the fixed IP. */
export function markerHolds(
    marker: EgressFixedIpMarker | undefined,
    now: number,
): boolean {
    if (marker?.required !== true) return false;
    if (marker.source !== 'clone_fallback') return true;
    const detectedAt = Date.parse(marker.detectedAt ?? '');
    const ttl =
        FIXED_IP_MARKER_TTL_MS[marker.reason as FixedIpReason] ??
        FIXED_IP_MARKER_TTL_MS.other;
    return Number.isFinite(detectedAt) && now - detectedAt < ttl;
}
