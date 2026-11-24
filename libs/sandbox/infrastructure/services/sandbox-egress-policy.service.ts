import { Inject, Injectable, Optional } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import {
    FixedEgressIpNoIntegrationError,
    FixedEgressIpPlanRequiredError,
    isFixedEgressIpPlanAllowed,
} from '@libs/sandbox/domain/egress-plan';

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
    /**
     * `manual`: the team turned the fixed outbound IP on or off in Git
     * settings. `clone_fallback`: a direct clone failed and the same clone
     * through the proxy worked.
     */
    source?: 'clone_fallback' | 'manual';
    detectedAt?: string;
    updatedBy?: string;
}

/**
 * `global_parameters.configValue` for `sandbox_egress`. Absent = nobody
 * leaves direct, which is the behavior before this existed.
 *
 *   { "directOrganizationIds": ["<org uuid>"] }   // rollout to a few orgs
 *   { "directByDefault": true }                   // every org
 *   { "fixedIp": "203.0.113.10" }                 // the IP Git settings shows
 *
 * Inside the rollout a sandbox leaves direct unless its organization's plan
 * includes the fixed outbound IP (Teams, Enterprise, trial) AND its team has
 * it on: turned on in Git settings, or found needed by the clone fallback.
 */
export interface EgressRollout {
    directByDefault: boolean;
    directOrganizationIds: string[];
    fixedIp?: string;
}

/** What Git settings shows and changes for a team. */
export interface FixedEgressIpSetting {
    /** The organization's plan includes the fixed outbound IP. */
    allowedByPlan: boolean;
    /** The team's sandboxes go through the fixed IP. */
    enabled: boolean;
    /** Who turned it on: the team, or the clone fallback. */
    source?: EgressFixedIpMarker['source'];
    reason?: FixedIpReason;
    updatedAt?: string;
    /** The IP the team's Git host must accept. */
    fixedIp?: string;
}

export interface ISandboxEgressPolicy {
    route(scope: EgressScope | undefined): Promise<EgressRoute>;
    /** Whether the organization's plan includes the fixed outbound IP. */
    fixedIpAllowed(scope: EgressScope): Promise<boolean>;
    markFixedIpRequired(
        scope: EgressScope,
        reason: FixedIpReason,
    ): Promise<void>;
    /** The team's setting as Git settings shows it. */
    getFixedIpSetting(scope: EgressScope): Promise<FixedEgressIpSetting>;
    /** Turns the team's fixed outbound IP on or off by hand. */
    setFixedIp(
        scope: EgressScope,
        enabled: boolean,
        actorUserId?: string,
    ): Promise<FixedEgressIpSetting>;
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
/** A plan answer is reused this long: an upgrade or a downgrade reaches the
 * route within it. */
const PLAN_TTL_MS = 10 * 60_000;
const planCacheKey = (scope: EgressScope) =>
    `sandbox-egress:plan:${scope.organizationId}`;

/**
 * Decides, per team, whether a sandbox needs the fixed egress IP.
 *
 * Outside the rollout every sandbox keeps the fixed IP, which is what they
 * all did before. Inside it, the fixed IP is a paid-plan feature the team
 * turns on: an organization whose plan does not include it always leaves
 * direct, a paying team leaves direct unless it is marked. A team is marked
 * by hand in Git settings, or by the clone fallback (E2BSandboxService) when
 * its direct clone failed and the same clone through the proxy worked.
 * A doubt about the marker resolves to `fixed_ip`; a doubt about the plan
 * (billing could not answer) keeps the team's marker.
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
        @Optional()
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService?: Pick<
            ILicenseService,
            'validateOrganizationLicense'
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

        if (!(await this.fixedIpAllowed(scope))) return 'direct';

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

    async fixedIpAllowed(scope: EgressScope): Promise<boolean> {
        const key = planCacheKey(scope);
        const cached = await this.cache
            ?.getFromCache<{ allowed: boolean }>(key)
            .catch(() => null);
        if (cached && typeof cached.allowed === 'boolean') {
            return cached.allowed;
        }
        const { allowed, definitive } = await this.readPlan(scope);
        if (definitive) {
            await this.cache
                ?.addToCache(key, { allowed }, PLAN_TTL_MS)
                .catch(() => undefined);
        }
        return allowed;
    }

    /** The team's fixed outbound IP as Git settings shows it, read fresh. */
    async getFixedIpSetting(scope: EgressScope): Promise<FixedEgressIpSetting> {
        const [{ allowed }, config, rollout] = await Promise.all([
            this.readPlan(scope),
            this.integrationConfigs?.findOne({
                team: { uuid: scope.teamId },
                configKey: IntegrationConfigKey.EGRESS_FIXED_IP,
            }),
            this.readRollout(),
        ]);
        const marker = config?.configValue as EgressFixedIpMarker | undefined;
        const holds = markerHolds(marker, Date.now());
        return {
            allowedByPlan: allowed,
            enabled: allowed && holds,
            ...(holds && marker?.source ? { source: marker.source } : {}),
            ...(holds && marker?.reason ? { reason: marker.reason } : {}),
            ...(marker?.detectedAt ? { updatedAt: marker.detectedAt } : {}),
            ...(rollout.fixedIp ? { fixedIp: rollout.fixedIp } : {}),
        };
    }

    /**
     * Turns the team's fixed outbound IP on or off by hand. A manual marker
     * never expires. Turning it on needs a plan that includes it; turning it
     * off never does, so a team that left a paid plan can still clear it.
     * This process routes the team the new way at once; other workers
     * within the marker cache window.
     */
    async setFixedIp(
        scope: EgressScope,
        enabled: boolean,
        actorUserId?: string,
    ): Promise<FixedEgressIpSetting> {
        if (enabled && !(await this.readPlan(scope)).allowed) {
            throw new FixedEgressIpPlanRequiredError();
        }
        const integrationId = await this.codeManagementIntegrationId(scope);
        if (!integrationId) throw new FixedEgressIpNoIntegrationError();

        const marker: EgressFixedIpMarker = {
            required: enabled,
            source: 'manual',
            detectedAt: new Date().toISOString(),
            ...(actorUserId ? { updatedBy: actorUserId } : {}),
        };
        await this.integrationConfigs!.createOrUpdateConfig(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            marker,
            integrationId,
            { organizationId: scope.organizationId, teamId: scope.teamId },
        );
        this.markedAt.set(markerCacheKey(scope), ++this.markSeq);
        await this.cacheMarker(scope, enabled);
        this.logger.log({
            message: `[egress] fixed outbound IP turned ${enabled ? 'on' : 'off'} in Git settings`,
            context: SandboxEgressPolicyService.name,
            metadata: { ...scope, enabled, actorUserId },
        });
        return this.getFixedIpSetting(scope);
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
            const integrationId = await this.codeManagementIntegrationId(scope);
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

    /** The team's code management integration: the one holding its
     * repository list. */
    private async codeManagementIntegrationId(
        scope: EgressScope,
    ): Promise<string | undefined> {
        const repositories = await this.integrationConfigs?.findOne({
            team: { uuid: scope.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });
        return repositories?.integration?.uuid;
    }

    /**
     * The plan answer, uncached. `definitive` is false when billing could
     * not answer: that read keeps the fixed IP and is not reused.
     */
    private async readPlan(
        scope: EgressScope,
    ): Promise<{ allowed: boolean; definitive: boolean }> {
        // No license service (tests, an install without billing): the plan
        // never takes a team's fixed IP away.
        if (!this.licenseService) return { allowed: true, definitive: false };
        try {
            const license =
                await this.licenseService.validateOrganizationLicense({
                    organizationId: scope.organizationId,
                    teamId: scope.teamId,
                });
            return {
                allowed: isFixedEgressIpPlanAllowed(license),
                definitive: !license?.unavailable,
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the license for the fixed outbound IP; keeping the team marker',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope },
            });
            return { allowed: true, definitive: false };
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
    const fixedIp =
        typeof v.fixedIp === 'string' && v.fixedIp.trim()
            ? v.fixedIp.trim()
            : undefined;
    return {
        directByDefault: v.directByDefault === true,
        directOrganizationIds: ids,
        ...(fixedIp ? { fixedIp } : {}),
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
