import { Test } from '@nestjs/testing';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';

import {
    LICENSE_SERVICE_TOKEN,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';
import {
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
} from '@libs/sandbox/domain/egress-plan';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import {
    markerHolds,
    parseEgressRollout,
    SandboxEgressPolicyService,
} from './sandbox-egress-policy.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const scope = { organizationId: ORG, teamId: TEAM };

const LICENSES = {
    teams: {
        valid: true,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        planType: 'teams_byok',
    },
    enterprise: {
        valid: true,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        planType: 'enterprise',
    },
    trial: { valid: true, subscriptionStatus: SubscriptionStatus.TRIAL },
    free: {
        valid: true,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        planType: 'free_byok',
    },
    expired: { valid: false, subscriptionStatus: SubscriptionStatus.EXPIRED },
    paymentFailed: {
        valid: false,
        subscriptionStatus: SubscriptionStatus.PAYMENT_FAILED,
        planType: 'teams_byok',
    },
    /** Billing answered with a client error (a rotated key, a 404). */
    refused: { valid: false },
    unavailable: { valid: false, unavailable: true },
} as const;

/** In-memory stand-in for the process cache (CacheService). */
const memoryCache = () => {
    const store = new Map<string, unknown>();
    return {
        store,
        getFromCache: jest.fn(async (k: string) =>
            store.has(k) ? (store.get(k) as any) : null,
        ),
        addToCache: jest.fn(async (k: string, v: unknown) => {
            store.set(k, v);
        }),
    };
};

const build = (opts: {
    rollout?: unknown;
    marker?: unknown;
    markerError?: Error;
    rolloutError?: Error;
    writeError?: Error;
    /** The organization's license; absent = no license service. */
    license?: keyof typeof LICENSES;
    licenseError?: Error;
}) => {
    const globalParameters = {
        findByKey: jest.fn(async (key: GlobalParametersKey) => {
            if (opts.rolloutError) throw opts.rolloutError;
            expect(key).toBe(GlobalParametersKey.SANDBOX_EGRESS);
            return opts.rollout === undefined
                ? null
                : { configValue: opts.rollout };
        }),
    };
    const orgParams = {
        findByKey: jest.fn(
            async (
                key: OrganizationParametersKey,
                _org: { organizationId: string },
            ) => {
                expect(key).toBe(OrganizationParametersKey.EGRESS_FIXED_IP);
                if (opts.markerError) throw opts.markerError;
                return opts.marker === undefined
                    ? null
                    : { configValue: opts.marker };
            },
        ),
        createOrUpdateConfig: jest.fn(async () => {
            if (opts.writeError) throw opts.writeError;
            return {};
        }),
    };
    const cache = memoryCache();
    const licenseService =
        opts.license || opts.licenseError
            ? {
                  validateOrganizationLicense: jest.fn(async () => {
                      if (opts.licenseError) throw opts.licenseError;
                      return { ...LICENSES[opts.license!] };
                  }),
              }
            : undefined;
    const service = new SandboxEgressPolicyService(
        globalParameters as any,
        orgParams as any,
        cache as any,
        licenseService as any,
    );
    return {
        service,
        globalParameters,
        orgParams,
        cache,
        licenseService,
    };
};

describe('SandboxEgressPolicyService.decide', () => {
    it.each([
        [{}, 'fixed_ip', 'rollout_off'],
        [
            { rollout: { directByDefault: true }, license: 'free' as const },
            'direct',
            'not_in_plan',
        ],
        [
            {
                rollout: { directByDefault: true },
                license: 'teams' as const,
                marker: { required: true, source: 'manual' },
            },
            'fixed_ip',
            'marked',
        ],
        [
            { rollout: { directByDefault: true }, license: 'teams' as const },
            'direct',
            'not_marked',
        ],
        [
            {
                rollout: { directByDefault: true },
                license: 'teams' as const,
                markerError: new Error('pg down'),
            },
            'fixed_ip',
            'marker_unreadable',
        ],
    ])('says why it picked the route (%#)', async (opts, route, why) => {
        const { service } = build(opts);
        await expect(service.decide(scope)).resolves.toEqual({ route, why });
    });

    it('says the setting could not be read, not that there was no organization, when it has nowhere to read it from', async () => {
        const { globalParameters } = build({
            rollout: { directByDefault: true },
        });
        const service = new SandboxEgressPolicyService(
            globalParameters as any,
            undefined,
            undefined,
            undefined,
        );
        await expect(service.decide(scope)).resolves.toEqual({
            route: 'fixed_ip',
            why: 'marker_unreadable',
        });
    });

    it('says there was nothing to decide for a sandbox without a team', async () => {
        const { service } = build({ rollout: { directByDefault: true } });
        await expect(service.decide(undefined)).resolves.toEqual({
            route: 'fixed_ip',
            why: 'no_scope',
        });
    });
});

describe('SandboxEgressPolicyService per organization', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const otherScope = { organizationId: OTHER, teamId: TEAM };
    const twoOrgs = () => {
        const cache = memoryCache();
        const licenseService = {
            validateOrganizationLicense: jest.fn(async () => ({
                ...LICENSES.teams,
            })),
        };
        const orgParams = {
            findByKey: jest.fn(
                async (_key: unknown, where: { organizationId?: string }) =>
                    where?.organizationId === ORG
                        ? {
                              configValue: {
                                  required: true,
                                  source: 'manual',
                              },
                          }
                        : null,
            ),
            createOrUpdateConfig: jest.fn(),
        };
        const service = new SandboxEgressPolicyService(
            {
                findByKey: jest.fn(async () => ({
                    configValue: { directByDefault: true },
                })),
            } as any,
            orgParams as any,
            cache as any,
            licenseService as any,
        );
        return { service, licenseService };
    };

    it("never lets one organization's marker route another, through the shared cache", async () => {
        const { service } = twoOrgs();
        await expect(service.decide(scope)).resolves.toEqual({
            route: 'fixed_ip',
            why: 'marked',
        });
        await expect(service.decide(otherScope)).resolves.toEqual({
            route: 'direct',
            why: 'not_marked',
        });
    });

    it("asks billing for the sandbox's own organization and team", async () => {
        const { service, licenseService } = twoOrgs();
        await service.decide(otherScope);
        expect(licenseService.validateOrganizationLicense).toHaveBeenCalledWith(
            { organizationId: OTHER, teamId: TEAM },
        );
        await service.getFixedIpSetting(ORG);
        expect(licenseService.validateOrganizationLicense).toHaveBeenCalledWith(
            { organizationId: ORG },
        );
    });

    it('decides nothing for a sandbox with an organization but no team', async () => {
        const { service, licenseService } = twoOrgs();
        await expect(
            service.decide({ organizationId: ORG } as any),
        ).resolves.toEqual({ route: 'fixed_ip', why: 'no_scope' });
        expect(
            licenseService.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });
});

describe('SandboxEgressPolicyService.route', () => {
    it('keeps every sandbox on the fixed IP while direct egress is not rolled out (today)', async () => {
        const { service } = build({});
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('sends an unmarked team direct once its organization is in the rollout', async () => {
        const { service } = build({
            rollout: { directOrganizationIds: [ORG] },
        });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('sends an unmarked team direct when the rollout covers every organization', async () => {
        const { service } = build({ rollout: { directByDefault: true } });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('keeps the fixed IP for an organization the rollout does not list', async () => {
        const { service } = build({
            rollout: { directOrganizationIds: ['someone-else'] },
        });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('keeps the fixed IP for a team marked as needing it, even with the rollout on for all', async () => {
        const { service } = build({
            rollout: { directByDefault: true },
            marker: { required: true, reason: 'ip_allow_list' },
        });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('sends a team direct again once its marker is set to not required (manual unmark)', async () => {
        const { service } = build({
            rollout: { directByDefault: true },
            marker: { required: false, source: 'manual' },
        });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('keeps the fixed IP when it cannot tell (marker unreadable)', async () => {
        const { service } = build({
            rollout: { directByDefault: true },
            markerError: new Error('pg down'),
        });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('keeps the fixed IP when it cannot tell (rollout unreadable)', async () => {
        const { service } = build({ rolloutError: new Error('pg down') });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('keeps the fixed IP for a sandbox that does not say which team it serves', async () => {
        const { service, orgParams } = build({
            rollout: { directByDefault: true },
        });
        await expect(service.route(undefined)).resolves.toBe('fixed_ip');
        expect(orgParams.findByKey).not.toHaveBeenCalled();
    });

    it('reads a team marker once and answers from cache after, unmarked teams included', async () => {
        const { service, orgParams, globalParameters } = build({
            rollout: { directByDefault: true },
        });
        await service.route(scope);
        await service.route(scope);
        await service.route(scope);
        expect(orgParams.findByKey.mock.calls).toHaveLength(1);
        expect(globalParameters.findByKey).toHaveBeenCalledTimes(1);
    });
});

describe('SandboxEgressPolicyService.route by plan', () => {
    const marked = { required: true, source: 'manual' };
    const on = { directByDefault: true };

    it('sends a free organization direct even when its team has the fixed IP on', async () => {
        const { service } = build({
            rollout: on,
            marker: marked,
            license: 'free',
        });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('sends an organization whose subscription expired direct', async () => {
        const { service } = build({
            rollout: on,
            marker: marked,
            license: 'expired',
        });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('keeps the fixed IP for a team that turned it on, on Teams, Enterprise or a trial', async () => {
        for (const license of ['teams', 'enterprise', 'trial'] as const) {
            const { service } = build({ rollout: on, marker: marked, license });
            await expect(service.route(scope)).resolves.toBe('fixed_ip');
        }
    });

    it('sends a paying team that never turned the fixed IP on direct', async () => {
        const { service } = build({ rollout: on, license: 'teams' });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('keeps the team marker when billing cannot answer', async () => {
        for (const opts of [
            { license: 'unavailable' as const },
            { licenseError: new Error('billing down') },
        ]) {
            const { service } = build({ rollout: on, marker: marked, ...opts });
            await expect(service.route(scope)).resolves.toBe('fixed_ip');
        }
    });

    it('asks billing once per organization and answers from cache after', async () => {
        const { service, licenseService } = build({
            rollout: on,
            license: 'free',
        });
        await service.route(scope);
        await service.route(scope);
        expect(
            licenseService!.validateOrganizationLicense,
        ).toHaveBeenCalledTimes(1);
    });

    it('asks billing again once the short entry for a failed read is gone', async () => {
        const { service, licenseService, cache } = build({
            rollout: on,
            license: 'unavailable',
        });
        await service.route(scope);
        cache.store.delete(`sandbox-egress:plan:${ORG}`);
        await service.route(scope);
        expect(
            licenseService!.validateOrganizationLicense,
        ).toHaveBeenCalledTimes(2);
    });

    it('does not ask billing while direct egress is not rolled out', async () => {
        const { service, licenseService } = build({ license: 'free' });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
        expect(
            licenseService!.validateOrganizationLicense,
        ).not.toHaveBeenCalled();
    });
});

describe('SandboxEgressPolicyService fixed IP setting', () => {
    const on = { directByDefault: true, fixedIp: '203.0.113.10' };

    it('turns the fixed IP on for a paying team and routes it there at once', async () => {
        const { service, orgParams } = build({
            rollout: on,
            license: 'teams',
        });
        await expect(service.route(scope)).resolves.toBe('direct');

        const setting = await service.setFixedIp(ORG, true, {
            actorUserId: 'user-1',
        });

        expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            expect.objectContaining({
                required: true,
                source: 'manual',
                updatedBy: 'user-1',
            }),
            { organizationId: ORG },
        );
        expect(setting).toEqual(
            expect.objectContaining({
                allowedByPlan: true,
                fixedIp: '203.0.113.10',
            }),
        );
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('refuses to turn it on for a free organization and stores nothing', async () => {
        const { service, orgParams } = build({
            rollout: on,
            license: 'free',
        });
        await expect(service.setFixedIp(ORG, true)).rejects.toBeInstanceOf(
            FixedEgressIpPlanRequiredError,
        );
        expect(orgParams.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('refuses to turn it on while billing cannot say the plan, and stores nothing', async () => {
        for (const opts of [
            { license: 'unavailable' as const },
            { licenseError: new Error('billing down') },
        ]) {
            const { service, orgParams } = build({
                rollout: on,
                ...opts,
            });
            await expect(service.setFixedIp(ORG, true)).rejects.toBeInstanceOf(
                FixedEgressIpPlanUnconfirmedError,
            );
            expect(orgParams.createOrUpdateConfig).not.toHaveBeenCalled();
        }
    });

    it('says the plan is unconfirmed while billing cannot answer, and not once it does', async () => {
        const down = build({ rollout: on, license: 'unavailable' });
        await expect(down.service.getFixedIpSetting(ORG)).resolves.toEqual(
            expect.objectContaining({ planUnconfirmed: true }),
        );
        const up = build({ rollout: on, license: 'teams' });
        const setting = await up.service.getFixedIpSetting(ORG);
        expect(setting.planUnconfirmed).toBeUndefined();
    });

    it('lets a team turn it off while billing cannot say the plan', async () => {
        const { service, orgParams } = build({
            rollout: on,
            license: 'unavailable',
        });
        await service.setFixedIp(ORG, false);
        expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            expect.objectContaining({ required: false }),
            { organizationId: ORG },
        );
    });

    it('lets a team that left a paid plan turn it off', async () => {
        const { service, orgParams } = build({
            rollout: on,
            license: 'free',
        });
        await service.setFixedIp(ORG, false);
        expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            expect.objectContaining({ required: false, source: 'manual' }),
            { organizationId: ORG },
        );
    });

    it('shows a downgraded team as off, though its marker is still stored', async () => {
        const { service } = build({
            rollout: on,
            license: 'free',
            marker: { required: true, source: 'manual' },
        });
        await expect(service.getFixedIpSetting(ORG)).resolves.toEqual(
            expect.objectContaining({ allowedByPlan: false, enabled: false }),
        );
    });

    it('says when an owner turned it off, which a refused clone does not undo', async () => {
        const off = build({
            rollout: on,
            license: 'teams',
            marker: { required: false, source: 'manual' },
        });
        await expect(off.service.getFixedIpSetting(ORG)).resolves.toEqual(
            expect.objectContaining({ enabled: false, turnedOff: true }),
        );
        await expect(off.service.fixedIpFallback(scope)).resolves.toBe(
            'turned_off',
        );

        for (const marker of [
            undefined,
            {
                required: false,
                source: 'clone_fallback',
                detectedAt: new Date().toISOString(),
            },
        ]) {
            const never = build({ rollout: on, license: 'teams', marker });
            const setting = await never.service.getFixedIpSetting(ORG);
            expect(setting.turnedOff).toBeUndefined();
        }
    });

    it('says nothing about who or why once an automatic marker has expired', async () => {
        const { service } = build({
            rollout: on,
            license: 'teams',
            marker: {
                required: true,
                source: 'clone_fallback',
                reason: 'unreachable',
                detectedAt: '2020-01-01T00:00:00Z',
            },
        });
        const setting = await service.getFixedIpSetting(ORG);
        expect(setting.enabled).toBe(false);
        expect(setting.source).toBeUndefined();
        expect(setting.reason).toBeUndefined();
    });

    it('does not call a fixed IP an owner turned on "turned off"', async () => {
        const { service } = build({
            rollout: on,
            license: 'teams',
            marker: { required: true, source: 'manual' },
        });
        const setting = await service.getFixedIpSetting(ORG);
        expect(setting.enabled).toBe(true);
        expect(setting.turnedOff).toBeUndefined();
    });

    it('shows a fixed IP the clone fallback turned on, and why', async () => {
        const { service } = build({
            rollout: on,
            license: 'enterprise',
            marker: {
                required: true,
                source: 'clone_fallback',
                reason: 'ip_allow_list',
                detectedAt: new Date().toISOString(),
            },
        });
        await expect(service.getFixedIpSetting(ORG)).resolves.toEqual(
            expect.objectContaining({
                enabled: true,
                source: 'clone_fallback',
                reason: 'ip_allow_list',
                fixedIp: '203.0.113.10',
                updatedAt: expect.any(String),
            }),
        );
    });
});

describe('markerHolds', () => {
    const DAY = 24 * 60 * 60_000;
    const now = Date.parse('2026-11-17T12:00:00Z');
    const auto = (reason: string, daysAgo: number) => ({
        required: true,
        source: 'clone_fallback' as const,
        reason: reason as any,
        detectedAt: new Date(now - daysAgo * DAY).toISOString(),
    });

    it('lets a team be tried direct again a day after an unreachable host marked it (a blip heals itself)', () => {
        expect(markerHolds(auto('unreachable', 0.5), now)).toBe(true);
        expect(markerHolds(auto('unreachable', 2), now)).toBe(false);
        expect(markerHolds(auto('other', 2), now)).toBe(false);
    });

    it('keeps a marker from a refusal that names the IP for a month', () => {
        expect(markerHolds(auto('ip_allow_list', 10), now)).toBe(true);
        expect(markerHolds(auto('forbidden', 29), now)).toBe(true);
        expect(markerHolds(auto('ip_allow_list', 31), now)).toBe(false);
    });

    it('lets the team go direct again at the exact moment the marker expires', () => {
        const atExpiry = {
            required: true,
            source: 'clone_fallback' as const,
            reason: 'unreachable' as const,
            detectedAt: new Date(now - DAY).toISOString(),
        };
        expect(markerHolds(atExpiry, now)).toBe(false);
        expect(markerHolds(atExpiry, now - 1)).toBe(true);
    });

    it('never expires a marker set by hand', () => {
        expect(
            markerHolds(
                {
                    required: true,
                    source: 'manual',
                    detectedAt: '2020-01-01T00:00:00Z',
                },
                now,
            ),
        ).toBe(true);
    });

    it('drops an automatic marker whose date cannot be read', () => {
        expect(
            markerHolds(
                {
                    required: true,
                    source: 'clone_fallback',
                    reason: 'ip_allow_list',
                },
                now,
            ),
        ).toBe(false);
    });
});

describe('SandboxEgressPolicyService under Nest', () => {
    it('gets the process cache injected, so a marker is read once per team', async () => {
        const cache = memoryCache();
        const findByKey = jest.fn(async () => null);
        const moduleRef = await Test.createTestingModule({
            providers: [
                SandboxEgressPolicyService,
                { provide: CacheService, useValue: cache },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: { findByKey, createOrUpdateConfig: jest.fn() },
                },
                {
                    provide: GLOBAL_PARAMETERS_SERVICE_TOKEN,
                    useValue: {
                        findByKey: async () => ({
                            configValue: { directByDefault: true },
                        }),
                    },
                },
            ],
        }).compile();
        const service = moduleRef.get(SandboxEgressPolicyService);

        await service.route(scope);
        await service.route(scope);

        expect(cache.addToCache).toHaveBeenCalled();
        expect(findByKey).toHaveBeenCalledTimes(1);
    });
});

describe('SandboxEgressPolicyService under Nest, with billing', () => {
    it('gets the license service injected, so a free organization leaves direct', async () => {
        const validateOrganizationLicense = jest.fn(async () => ({
            ...LICENSES.free,
        }));
        const moduleRef = await Test.createTestingModule({
            providers: [
                SandboxEgressPolicyService,
                { provide: CacheService, useValue: memoryCache() },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: {
                        findByKey: jest.fn(async () => ({
                            configValue: { required: true, source: 'manual' },
                        })),
                        createOrUpdateConfig: jest.fn(),
                    },
                },
                {
                    provide: GLOBAL_PARAMETERS_SERVICE_TOKEN,
                    useValue: {
                        findByKey: async () => ({
                            configValue: { directByDefault: true },
                        }),
                    },
                },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: { validateOrganizationLicense },
                },
            ],
        }).compile();
        const service = moduleRef.get(SandboxEgressPolicyService);

        await expect(service.route(scope)).resolves.toBe('direct');
        expect(validateOrganizationLicense).toHaveBeenCalled();
    });
});

describe('SandboxEgressPolicyService review findings (#2693)', () => {
    const on = { directByDefault: true, fixedIp: '203.0.113.10' };
    const manualOn = { required: true, source: 'manual' };
    const manualOff = { required: false, source: 'manual' };

    it('answers each organization with its own plan from one worker', async () => {
        const OTHER = '44444444-4444-4444-8444-444444444444';
        const { service, licenseService } = build({
            rollout: on,
            marker: manualOn,
            license: 'teams',
        });
        licenseService!.validateOrganizationLicense.mockImplementation((async ({
            organizationId,
        }: {
            organizationId: string;
        }) =>
            organizationId === ORG
                ? { ...LICENSES.teams }
                : { ...LICENSES.free }) as any);
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
        await expect(
            service.route({ organizationId: OTHER, teamId: TEAM }),
        ).resolves.toBe('direct');
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('keeps a "not included" and a failed billing read for a minute only, a paid plan for ten', async () => {
        for (const [license, ttl] of [
            ['free', 60_000],
            ['refused', 60_000],
            ['unavailable', 60_000],
            ['teams', 600_000],
        ] as const) {
            const { service, cache } = build({ rollout: on, license });
            await service.route(scope);
            expect(cache.addToCache).toHaveBeenCalledWith(
                `sandbox-egress:plan:${ORG}`,
                expect.anything(),
                ttl,
            );
        }
    });

    it('asks a billing that cannot answer once a minute, not once per sandbox', async () => {
        const { service, licenseService } = build({
            rollout: on,
            marker: manualOn,
            license: 'unavailable',
        });
        for (let i = 0; i < 5; i++) {
            await expect(service.route(scope)).resolves.toBe('fixed_ip');
        }
        expect(
            licenseService!.validateOrganizationLicense,
        ).toHaveBeenCalledTimes(1);
    });

    it('stops waiting for billing after 5 seconds and keeps the team marker', async () => {
        jest.useFakeTimers();
        try {
            const { service, licenseService } = build({
                rollout: on,
                marker: manualOn,
                license: 'teams',
            });
            licenseService!.validateOrganizationLicense.mockImplementation(
                () => new Promise(() => undefined),
            );
            const routed = service.route(scope);
            await jest.advanceTimersByTimeAsync(5_000);
            await expect(routed).resolves.toBe('fixed_ip');
        } finally {
            jest.useRealTimers();
        }
    });

    it('lets a failed clone fall back right after an upgrade, though a "not included" is cached', async () => {
        const { service, licenseService } = build({
            rollout: on,
            license: 'free',
        });
        await expect(service.route(scope)).resolves.toBe('direct');
        licenseService!.validateOrganizationLicense.mockResolvedValue({
            ...LICENSES.teams,
        });
        await expect(service.fixedIpFallback(scope)).resolves.toBe('allowed');
    });

    it('blocks the fallback for a plan without it, and for a team that turned it off by hand', async () => {
        await expect(
            build({ rollout: on, license: 'free' }).service.fixedIpFallback(
                scope,
            ),
        ).resolves.toBe('plan');
        await expect(
            build({
                rollout: on,
                license: 'teams',
                marker: manualOff,
            }).service.fixedIpFallback(scope),
        ).resolves.toBe('turned_off');
        await expect(
            build({ rollout: on, license: 'teams' }).service.fixedIpFallback(
                scope,
            ),
        ).resolves.toBe('allowed');
        await expect(
            build({
                rollout: on,
                license: 'teams',
                markerError: new Error('db down'),
            }).service.fixedIpFallback(scope),
        ).resolves.toBe('allowed');
    });

    it('routes a team direct as soon as it turns the IP off in this process', async () => {
        const { service } = build({
            rollout: on,
            license: 'teams',
            marker: manualOn,
        });
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
        await service.setFixedIp(ORG, false);
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('a marker read in flight while the team turns it off answers off', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { service, orgParams, cache } = build({
            rollout: on,
            license: 'teams',
            marker: manualOn,
        });
        const original = orgParams.findByKey.getMockImplementation()!;
        let reads = 0;
        orgParams.findByKey.mockImplementation(async (key, org) => {
            // Only the route's read waits; the setting read after the write
            // answers at once.
            if (reads++ === 0) await gate;
            return original(key, org);
        });
        const routed = service.route(scope);
        await new Promise((r) => setImmediate(r));
        await service.setFixedIp(ORG, false);
        cache.store.delete(`sandbox-egress:fixed-ip:${ORG}`);
        release();
        await expect(routed).resolves.toBe('direct');
    });

    it('shows a downgraded team its stored choice so it can clear it', async () => {
        const setting = await build({
            rollout: on,
            license: 'free',
            marker: manualOn,
        }).service.getFixedIpSetting(ORG);
        expect(setting).toEqual(
            expect.objectContaining({
                allowedByPlan: false,
                enabled: false,
                savedOn: true,
            }),
        );
    });

    it('says whether direct egress is rolled out to the organization', async () => {
        for (const [rollout, inRollout] of [
            [undefined, false],
            [{ directOrganizationIds: ['someone-else'] }, false],
            [{ directOrganizationIds: [ORG] }, true],
            [{ directByDefault: true }, true],
        ] as const) {
            const setting = await build({
                rollout,
                license: 'teams',
            }).service.getFixedIpSetting(ORG);
            expect(setting.inRollout).toBe(inRollout);
        }
    });

    it('stores the choice on the organization, for every team in it', async () => {
        const OTHER_TEAM = '55555555-5555-4555-8555-555555555555';
        const { service, orgParams } = build({
            rollout: on,
            license: 'teams',
        });
        await service.setFixedIp(ORG, true);
        expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            expect.objectContaining({ required: true, source: 'manual' }),
            { organizationId: ORG },
        );
        await expect(
            service.route({ organizationId: ORG, teamId: OTHER_TEAM }),
        ).resolves.toBe('fixed_ip');
    });

    it('keeps the fixed IP for a Teams plan whose payment failed, not once it is canceled', async () => {
        await expect(
            build({
                rollout: on,
                license: 'paymentFailed',
                marker: manualOn,
            }).service.route(scope),
        ).resolves.toBe('fixed_ip');
        await expect(
            build({
                rollout: on,
                license: 'expired',
                marker: manualOn,
            }).service.route(scope),
        ).resolves.toBe('direct');
    });
});

describe('SandboxEgressPolicyService.markFixedIpRequired', () => {
    it('stores the marker on the organization', async () => {
        const { service, orgParams } = build({
            rollout: { directByDefault: true },
        });
        await service.markFixedIpRequired(scope, 'ip_allow_list');
        expect(orgParams.createOrUpdateConfig).toHaveBeenCalledWith(
            OrganizationParametersKey.EGRESS_FIXED_IP,
            expect.objectContaining({
                required: true,
                reason: 'ip_allow_list',
                source: 'clone_fallback',
            }),
            { organizationId: ORG },
        );
    });

    it('routes the team through the fixed IP right away, without reading the marker back', async () => {
        const { service, orgParams } = build({
            rollout: { directByDefault: true },
        });
        await expect(service.route(scope)).resolves.toBe('direct');
        await service.markFixedIpRequired(scope, 'unreachable');
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
        expect(orgParams.findByKey.mock.calls).toHaveLength(1);
    });

    it('does not let a marker read that started before the mark cache its older "not required" over it', async () => {
        const { service, orgParams } = build({
            rollout: { directByDefault: true },
        });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const realFindByKey = orgParams.findByKey.getMockImplementation()!;
        orgParams.findByKey.mockImplementation(async (key, org) => {
            await gate; // the database answers after the mark
            return realFindByKey(key, org);
        });

        const inFlight = service.route(scope);
        await new Promise((r) => setImmediate(r));
        await service.markFixedIpRequired(scope, 'ip_allow_list');
        release();

        await expect(inFlight).resolves.toBe('fixed_ip');
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });

    it('never throws when the marker cannot be stored, and still routes this worker through the fixed IP', async () => {
        const { service } = build({
            rollout: { directByDefault: true },
            writeError: new Error('pg down'),
        });
        await expect(
            service.markFixedIpRequired(scope, 'ip_allow_list'),
        ).resolves.toBeUndefined();
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
    });
});

describe('parseEgressRollout', () => {
    it('is off for anything that is not an object', () => {
        for (const v of [undefined, null, 'all', 1, true]) {
            expect(parseEgressRollout(v)).toEqual({
                directByDefault: false,
                directOrganizationIds: [],
            });
        }
    });

    it('only accepts a literal true to turn direct egress on for everyone', () => {
        expect(
            parseEgressRollout({ directByDefault: 'true' }).directByDefault,
        ).toBe(false);
        expect(
            parseEgressRollout({ directByDefault: true }).directByDefault,
        ).toBe(true);
    });

    it('keeps the fixed IP to show when it is a non-empty string', () => {
        expect(parseEgressRollout({ fixedIp: ' 203.0.113.10 ' }).fixedIp).toBe(
            '203.0.113.10',
        );
        expect(parseEgressRollout({ fixedIp: '' }).fixedIp).toBeUndefined();
        expect(parseEgressRollout({ fixedIp: '   ' }).fixedIp).toBeUndefined();
        expect(parseEgressRollout({ fixedIp: 7 }).fixedIp).toBeUndefined();
    });

    it('rolls out to no organization when the list is not a list', () => {
        expect(
            parseEgressRollout({ directOrganizationIds: ORG })
                .directOrganizationIds,
        ).toEqual([]);
    });

    it('keeps only string organization ids', () => {
        expect(
            parseEgressRollout({ directOrganizationIds: [ORG, 3, null, ''] })
                .directOrganizationIds,
        ).toEqual([ORG]);
    });
});
