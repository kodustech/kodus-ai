import { Inject, Injectable, Optional } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
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

/**
 * `organization_parameters.configValue` for `egress_fixed_ip`: the
 * organization's choice, for every team in it.
 */
export interface EgressFixedIpMarker {
    required: boolean;
    reason?: FixedIpReason;
    /**
     * `manual`: an owner turned the fixed outbound IP on or off in
     * Organization settings. `clone_fallback`: a direct clone failed and the
     * same clone through the proxy worked.
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
 *   { "fixedIp": "203.0.113.10" }                 // the IP the settings show
 *
 * Inside the rollout a sandbox leaves direct unless its organization's plan
 * includes the fixed outbound IP (Teams, Enterprise, trial) AND the
 * organization has it on: turned on in Organization settings, or found
 * needed by the clone fallback.
 */
export interface EgressRollout {
    directByDefault: boolean;
    directOrganizationIds: string[];
    fixedIp?: string;
}

/** What Organization settings shows and changes. */
export interface FixedEgressIpSetting {
    /** The organization's plan includes the fixed outbound IP. */
    allowedByPlan: boolean;
    /**
     * Billing was asked and could not answer: `allowedByPlan` is the routing
     * fallback, not a confirmed plan, and turning the IP on is refused until
     * billing answers. Absent when the plan was read.
     */
    planUnconfirmed?: boolean;
    /** The organization's sandboxes go through the fixed IP. */
    enabled: boolean;
    /**
     * The organization's stored choice is on (by hand or by the clone
     * fallback), whether or not the plan uses it now: a downgraded
     * organization sees it and can turn it off, so an upgrade later does not
     * bring it back unasked.
     */
    savedOn: boolean;
    /**
     * Direct egress is rolled out to the organization. Outside the rollout
     * every sandbox leaves from the fixed IP whatever this setting says, so
     * the settings do not offer it.
     */
    inRollout: boolean;
    /** Who turned it on: an owner, or the clone fallback. */
    source?: EgressFixedIpMarker['source'];
    reason?: FixedIpReason;
    updatedAt?: string;
    /** The IP the organization's Git host must accept. */
    fixedIp?: string;
}

/**
 * Whether a failed direct clone may be tried again through the fixed IP:
 * `allowed`, or blocked because the plan does not include it (`plan`) or
 * because an owner turned it off in Organization settings (`turned_off`).
 */
export type FixedIpFallback = 'allowed' | 'plan' | 'turned_off';

export interface ISandboxEgressPolicy {
    route(scope: EgressScope | undefined): Promise<EgressRoute>;
    /** Whether the organization's plan includes the fixed outbound IP. */
    fixedIpAllowed(scope: EgressScope): Promise<boolean>;
    /**
     * After a failed direct clone: whether to retry through the fixed IP.
     * Reads the plan and the organization's marker fresh (it runs once per
     * failed clone), so an upgrade or a toggle a minute ago already counts.
     */
    fixedIpFallback(scope: EgressScope): Promise<FixedIpFallback>;
    markFixedIpRequired(
        scope: EgressScope,
        reason: FixedIpReason,
    ): Promise<void>;
    /** The organization's setting as Organization settings shows it. */
    getFixedIpSetting(organizationId: string): Promise<FixedEgressIpSetting>;
    /** Turns the organization's fixed outbound IP on or off by hand. */
    setFixedIp(
        organizationId: string,
        enabled: boolean,
        options?: { actorUserId?: string },
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
 * An organization marker read is reused this long, unmarked organizations
 * included (most never get one). A marker written by another process is
 * seen here within this window; until then a direct clone of that
 * organization fails once more and falls back, which costs seconds, never
 * the review.
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

const markerCacheKey = (organizationId: string) =>
    `sandbox-egress:fixed-ip:${organizationId}`;
/** A plan that includes the fixed IP is reused this long: a downgrade
 * reaches the route within it. */
const PLAN_TTL_MS = 10 * 60_000;
/**
 * A "not included" answer, and an answer billing could not give, are reused
 * only this long. A 4xx from billing (a rotated key) reads like a real "no";
 * keeping it short bounds that blip, and a slow or rate-limited billing is
 * asked once a minute per worker instead of once per sandbox.
 */
const PLAN_SHORT_TTL_MS = 60_000;
/** Billing gets this long to answer before the read counts as failed. */
const PLAN_READ_TIMEOUT_MS = 5_000;
const planCacheKey = (organizationId: string) =>
    `sandbox-egress:plan:${organizationId}`;

/** Who a plan read is for: the organization, and the team when known. */
type PlanScope = { organizationId: string; teamId?: string };

/**
 * Decides, per organization, whether a sandbox needs the fixed egress IP.
 *
 * Outside the rollout every sandbox keeps the fixed IP, which is what they
 * all did before. Inside it, the fixed IP is a paid-plan feature the
 * organization turns on, for all its teams: an organization whose plan does
 * not include it always leaves direct, a paying one leaves direct unless it
 * is marked. It is marked by hand in Organization settings, or by the clone
 * fallback (E2BSandboxService) when a direct clone failed and the same clone
 * through the proxy worked. A doubt about the marker resolves to
 * `fixed_ip`; a doubt about the plan (billing could not answer) keeps the
 * marker.
 */
@Injectable()
export class SandboxEgressPolicyService implements ISandboxEgressPolicy {
    private readonly logger = createLogger(SandboxEgressPolicyService.name);
    private rollout: EgressRollout = OFF;
    private rolloutReadAt = 0;
    private rolloutRetryAt = 0;
    /**
     * Organizations this process marked, with the order of the mark and the
     * value it set. A marker read that started before a mark must not cache
     * its older answer over it.
     */
    private readonly markedAt = new Map<
        string,
        { seq: number; required: boolean }
    >();
    private markSeq = 0;

    constructor(
        @Optional()
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters?: Pick<
            IGlobalParametersService,
            'findByKey'
        >,
        @Optional()
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters?: Pick<
            IOrganizationParametersService,
            'findByKey' | 'createOrUpdateConfig'
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
        if (!this.organizationParameters) return 'fixed_ip';

        const rollout = await this.readRollout();
        if (
            !rollout.directByDefault &&
            !rollout.directOrganizationIds.includes(scope.organizationId)
        ) {
            return 'fixed_ip';
        }

        if (!(await this.fixedIpAllowed(scope))) return 'direct';

        try {
            return (await this.requiresFixedIp(scope.organizationId))
                ? 'fixed_ip'
                : 'direct';
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
        const cached = await this.cache
            ?.getFromCache<{ allowed: boolean }>(
                planCacheKey(scope.organizationId),
            )
            .catch(() => null);
        if (cached && typeof cached.allowed === 'boolean') {
            return cached.allowed;
        }
        const plan = await this.readPlan(scope);
        await this.cachePlan(scope.organizationId, plan);
        return plan.allowed;
    }

    async fixedIpFallback(scope: EgressScope): Promise<FixedIpFallback> {
        const plan = await this.readPlan(scope);
        await this.cachePlan(scope.organizationId, plan);
        if (!plan.allowed) return 'plan';
        try {
            const marker = await this.readMarker(scope.organizationId);
            // An owner chose the shared network by hand: Kody does not
            // override it, the failure says how to turn the IP on.
            if (marker?.source === 'manual' && marker.required === false) {
                return 'turned_off';
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the egress_fixed_ip marker for the clone fallback; retrying through the fixed IP',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope },
            });
        }
        return 'allowed';
    }

    /** The organization's fixed outbound IP as its settings show it, read
     * fresh. */
    async getFixedIpSetting(
        organizationId: string,
    ): Promise<FixedEgressIpSetting> {
        const [{ allowed, failed }, marker, rollout] = await Promise.all([
            this.readPlan({ organizationId }),
            this.readMarker(organizationId),
            this.readRollout(),
        ]);
        const holds = markerHolds(marker, Date.now());
        return {
            allowedByPlan: allowed,
            ...(failed ? { planUnconfirmed: true } : {}),
            enabled: allowed && holds,
            savedOn: holds,
            inRollout:
                rollout.directByDefault ||
                rollout.directOrganizationIds.includes(organizationId),
            ...(holds && marker?.source ? { source: marker.source } : {}),
            ...(holds && marker?.reason ? { reason: marker.reason } : {}),
            ...(marker?.detectedAt ? { updatedAt: marker.detectedAt } : {}),
            ...(rollout.fixedIp ? { fixedIp: rollout.fixedIp } : {}),
        };
    }

    /**
     * Turns the organization's fixed outbound IP on or off by hand, for all
     * its teams. A manual marker never expires. Turning it on needs a plan
     * that includes it, read from billing: an unread plan refuses rather
     * than grants (routing keeps an existing marker through a billing
     * outage, turning it on does not). Turning it off never needs the plan,
     * so an organization that left a paid plan can still clear it.
     * The process that writes it (the API) routes the organization the new
     * way at once; review workers keep their cached marker up to 10 minutes
     * (MARKER_TTL_MS), which the toggle's message says.
     */
    async setFixedIp(
        organizationId: string,
        enabled: boolean,
        options: { actorUserId?: string } = {},
    ): Promise<FixedEgressIpSetting> {
        const { actorUserId } = options;
        if (enabled) {
            const plan = await this.readPlan({ organizationId });
            await this.cachePlan(organizationId, plan);
            if (plan.failed) throw new FixedEgressIpPlanUnconfirmedError();
            if (!plan.allowed) throw new FixedEgressIpPlanRequiredError();
        }
        const marker: EgressFixedIpMarker = {
            required: enabled,
            source: 'manual',
            detectedAt: new Date().toISOString(),
            ...(actorUserId ? { updatedBy: actorUserId } : {}),
        };
        await this.organizationParameters!.createOrUpdateConfig(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            marker,
            { organizationId },
        );
        this.markedAt.set(markerCacheKey(organizationId), {
            seq: ++this.markSeq,
            required: enabled,
        });
        await this.cacheMarker(organizationId, enabled);
        this.logger.log({
            message: `[egress] fixed outbound IP turned ${enabled ? 'on' : 'off'} in Organization settings`,
            context: SandboxEgressPolicyService.name,
            metadata: { organizationId, enabled, actorUserId },
        });
        return this.getFixedIpSetting(organizationId);
    }

    async markFixedIpRequired(
        scope: EgressScope,
        reason: FixedIpReason,
    ): Promise<void> {
        // This worker stops trying direct for the organization first,
        // whatever happens to the write below.
        this.markedAt.set(markerCacheKey(scope.organizationId), {
            seq: ++this.markSeq,
            required: true,
        });
        await this.cacheMarker(scope.organizationId, true);

        try {
            if (!this.organizationParameters) return;
            const marker: EgressFixedIpMarker = {
                required: true,
                reason,
                source: 'clone_fallback',
                detectedAt: new Date().toISOString(),
            };
            await this.organizationParameters.createOrUpdateConfig(
                OrganizationParametersKey.EGRESS_FIXED_IP,
                marker,
                { organizationId: scope.organizationId },
            );
            this.logger.log({
                message: `[egress] organization marked as needing the fixed IP (${reason})`,
                context: SandboxEgressPolicyService.name,
                metadata: { ...scope, reason },
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not store the egress_fixed_ip marker; this worker keeps the fixed IP for the organization',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope, reason },
            });
        }
    }

    /** The organization's stored marker, if any. */
    private async readMarker(
        organizationId: string,
    ): Promise<EgressFixedIpMarker | undefined> {
        const param = await this.organizationParameters?.findByKey(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            { organizationId },
        );
        return param?.configValue as EgressFixedIpMarker | undefined;
    }

    /**
     * The plan answer, uncached. `definitive` is false when there was no
     * billing answer to reuse; `failed` is true when billing was asked and
     * could not answer. Either way routing keeps the fixed IP; only a failed
     * read stops the switch from turning it on.
     */
    private async readPlan(
        scope: PlanScope,
    ): Promise<{ allowed: boolean; definitive: boolean; failed: boolean }> {
        // No license service (tests, an install without billing): the plan
        // never takes a team's fixed IP away.
        if (!this.licenseService) {
            return { allowed: true, definitive: false, failed: false };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const license = await Promise.race([
                this.licenseService.validateOrganizationLicense({
                    organizationId: scope.organizationId,
                    ...(scope.teamId ? { teamId: scope.teamId } : {}),
                }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `billing did not answer within ${PLAN_READ_TIMEOUT_MS} ms`,
                                ),
                            ),
                        PLAN_READ_TIMEOUT_MS,
                    );
                }),
            ]);
            return {
                allowed: isFixedEgressIpPlanAllowed(license),
                definitive: !license?.unavailable,
                failed: Boolean(license?.unavailable),
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read the license for the fixed outbound IP; keeping the organization marker',
                context: SandboxEgressPolicyService.name,
                error,
                metadata: { ...scope },
            });
            return { allowed: true, definitive: false, failed: true };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * A plan with the fixed IP is reused for PLAN_TTL_MS; a "not included"
     * and a failed read for PLAN_SHORT_TTL_MS. No license service: nothing
     * to reuse.
     */
    private async cachePlan(
        organizationId: string,
        plan: { allowed: boolean; definitive: boolean; failed: boolean },
    ): Promise<void> {
        if (!plan.definitive && !plan.failed) return;
        const ttl =
            plan.definitive && plan.allowed ? PLAN_TTL_MS : PLAN_SHORT_TTL_MS;
        await this.cache
            ?.addToCache(
                planCacheKey(organizationId),
                { allowed: plan.allowed },
                ttl,
            )
            .catch(() => undefined);
    }

    private async requiresFixedIp(organizationId: string): Promise<boolean> {
        const key = markerCacheKey(organizationId);
        const cached = await this.cache
            ?.getFromCache<{ required: boolean }>(key)
            .catch(() => null);
        if (cached && typeof cached.required === 'boolean') {
            return cached.required;
        }

        const readStartedAt = this.markSeq;
        const marker = await this.readMarker(organizationId);
        // Marked by this process while the read was in flight: the read saw
        // the database before the mark, and the mark already cached its
        // value (on or off).
        const mark = this.markedAt.get(key);
        if (mark && mark.seq > readStartedAt) return mark.required;
        const required = markerHolds(marker, Date.now());
        await this.cacheMarker(organizationId, required);
        return required;
    }

    private async cacheMarker(
        organizationId: string,
        required: boolean,
    ): Promise<void> {
        await this.cache
            ?.addToCache(
                markerCacheKey(organizationId),
                { required },
                MARKER_TTL_MS,
            )
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

/** Whether a stored marker still sends the organization through the fixed
 * IP. */
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
