import { Test } from '@nestjs/testing';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

import {
    LICENSE_SERVICE_TOKEN,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';
import {
    FixedEgressIpPlanRequiredError,
    FixedEgressIpPlanUnconfirmedError,
} from '@libs/sandbox/domain/egress-plan';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import {
    markerHolds,
    parseEgressRollout,
    SandboxEgressPolicyService,
} from './sandbox-egress-policy.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const INTEGRATION = '33333333-3333-4333-8333-333333333333';
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
    repositoriesIntegration?: string | null;
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
    const integrationConfigs = {
        findOne: jest.fn(async (filter: any) => {
            if (filter.configKey === IntegrationConfigKey.EGRESS_FIXED_IP) {
                if (opts.markerError) throw opts.markerError;
                return opts.marker === undefined
                    ? null
                    : { configValue: opts.marker };
            }
            if (filter.configKey === IntegrationConfigKey.REPOSITORIES) {
                const id =
                    opts.repositoriesIntegration === undefined
                        ? INTEGRATION
                        : opts.repositoriesIntegration;
                return id ? { integration: { uuid: id } } : null;
            }
            return null;
        }),
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
        integrationConfigs as any,
        cache as any,
        licenseService as any,
    );
    return {
        service,
        globalParameters,
        integrationConfigs,
        cache,
        licenseService,
    };
};

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
        const { service, integrationConfigs } = build({
            rollout: { directByDefault: true },
        });
        await expect(service.route(undefined)).resolves.toBe('fixed_ip');
        expect(integrationConfigs.findOne).not.toHaveBeenCalled();
    });

    it('reads a team marker once and answers from cache after, unmarked teams included', async () => {
        const { service, integrationConfigs, globalParameters } = build({
            rollout: { directByDefault: true },
        });
        await service.route(scope);
        await service.route(scope);
        await service.route(scope);
        expect(
            integrationConfigs.findOne.mock.calls.filter(
                ([f]: any[]) =>
                    f.configKey === IntegrationConfigKey.EGRESS_FIXED_IP,
            ),
        ).toHaveLength(1);
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
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'teams',
        });
        await expect(service.route(scope)).resolves.toBe('direct');

        const setting = await service.setFixedIp(scope, true, {
            integrationId: INTEGRATION,
            actorUserId: 'user-1',
        });

        expect(integrationConfigs.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            expect.objectContaining({
                required: true,
                source: 'manual',
                updatedBy: 'user-1',
            }),
            INTEGRATION,
            { organizationId: ORG, teamId: TEAM },
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
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'free',
        });
        await expect(
            service.setFixedIp(scope, true, { integrationId: INTEGRATION }),
        ).rejects.toBeInstanceOf(FixedEgressIpPlanRequiredError);
        expect(integrationConfigs.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('refuses to turn it on while billing cannot say the plan, and stores nothing', async () => {
        for (const opts of [
            { license: 'unavailable' as const },
            { licenseError: new Error('billing down') },
        ]) {
            const { service, integrationConfigs } = build({
                rollout: on,
                ...opts,
            });
            await expect(
                service.setFixedIp(scope, true, { integrationId: INTEGRATION }),
            ).rejects.toBeInstanceOf(FixedEgressIpPlanUnconfirmedError);
            expect(
                integrationConfigs.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        }
    });

    it('says the plan is unconfirmed while billing cannot answer, and not once it does', async () => {
        const down = build({ rollout: on, license: 'unavailable' });
        await expect(
            down.service.getFixedIpSetting(scope, INTEGRATION),
        ).resolves.toEqual(expect.objectContaining({ planUnconfirmed: true }));
        const up = build({ rollout: on, license: 'teams' });
        const setting = await up.service.getFixedIpSetting(scope, INTEGRATION);
        expect(setting.planUnconfirmed).toBeUndefined();
    });

    it('lets a team turn it off while billing cannot say the plan', async () => {
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'unavailable',
        });
        await service.setFixedIp(scope, false, { integrationId: INTEGRATION });
        expect(integrationConfigs.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            expect.objectContaining({ required: false }),
            INTEGRATION,
            expect.anything(),
        );
    });

    it('lets a team that left a paid plan turn it off', async () => {
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'free',
        });
        await service.setFixedIp(scope, false, { integrationId: INTEGRATION });
        expect(integrationConfigs.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            expect.objectContaining({ required: false, source: 'manual' }),
            INTEGRATION,
            expect.anything(),
        );
    });

    it('shows a downgraded team as off, though its marker is still stored', async () => {
        const { service } = build({
            rollout: on,
            license: 'free',
            marker: { required: true, source: 'manual' },
        });
        await expect(
            service.getFixedIpSetting(scope, INTEGRATION),
        ).resolves.toEqual(
            expect.objectContaining({ allowedByPlan: false, enabled: false }),
        );
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
        await expect(
            service.getFixedIpSetting(scope, INTEGRATION),
        ).resolves.toEqual(
            expect.objectContaining({
                enabled: true,
                source: 'clone_fallback',
                reason: 'ip_allow_list',
                fixedIp: '203.0.113.10',
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
        const findOne = jest.fn(async () => null);
        const moduleRef = await Test.createTestingModule({
            providers: [
                SandboxEgressPolicyService,
                { provide: CacheService, useValue: cache },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: { findOne, createOrUpdateConfig: jest.fn() },
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
        expect(findOne).toHaveBeenCalledTimes(1);
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
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(async () => ({
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
        await service.setFixedIp(scope, false, { integrationId: INTEGRATION });
        await expect(service.route(scope)).resolves.toBe('direct');
    });

    it('a marker read in flight while the team turns it off answers off', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { service, integrationConfigs, cache } = build({
            rollout: on,
            license: 'teams',
            marker: manualOn,
        });
        const original = integrationConfigs.findOne.getMockImplementation()!;
        integrationConfigs.findOne.mockImplementation(async (filter: any) => {
            if (
                filter.configKey === IntegrationConfigKey.EGRESS_FIXED_IP &&
                !filter.integration
            ) {
                await gate;
            }
            return original(filter);
        });
        const routed = service.route(scope);
        await new Promise((r) => setImmediate(r));
        await service.setFixedIp(scope, false, { integrationId: INTEGRATION });
        cache.store.delete(`sandbox-egress:fixed-ip:${ORG}:${TEAM}`);
        release();
        await expect(routed).resolves.toBe('direct');
    });

    it('shows a downgraded team its stored choice so it can clear it', async () => {
        const setting = await build({
            rollout: on,
            license: 'free',
            marker: manualOn,
        }).service.getFixedIpSetting(scope, INTEGRATION);
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
            }).service.getFixedIpSetting(scope, INTEGRATION);
            expect(setting.inRollout).toBe(inRollout);
        }
    });

    it('reads and writes the setting on the integration it was given', async () => {
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'teams',
        });
        await service.setFixedIp(scope, true, { integrationId: 'int-x' });
        expect(integrationConfigs.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            expect.anything(),
            'int-x',
            { organizationId: ORG, teamId: TEAM },
        );
        expect(integrationConfigs.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                integration: { uuid: 'int-x' },
                configKey: IntegrationConfigKey.EGRESS_FIXED_IP,
            }),
        );
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
    it("stores the marker on the team's code management integration", async () => {
        const { service, integrationConfigs } = build({
            rollout: { directByDefault: true },
        });
        await service.markFixedIpRequired(scope, 'ip_allow_list');
        expect(integrationConfigs.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.EGRESS_FIXED_IP,
            expect.objectContaining({
                required: true,
                reason: 'ip_allow_list',
                source: 'clone_fallback',
            }),
            INTEGRATION,
            { organizationId: ORG, teamId: TEAM },
        );
    });

    it('routes the team through the fixed IP right away, without reading the marker back', async () => {
        const { service, integrationConfigs } = build({
            rollout: { directByDefault: true },
        });
        await expect(service.route(scope)).resolves.toBe('direct');
        await service.markFixedIpRequired(scope, 'unreachable');
        await expect(service.route(scope)).resolves.toBe('fixed_ip');
        expect(
            integrationConfigs.findOne.mock.calls.filter(
                ([f]: any[]) =>
                    f.configKey === IntegrationConfigKey.EGRESS_FIXED_IP,
            ),
        ).toHaveLength(1);
    });

    it('does not let a marker read that started before the mark cache its older "not required" over it', async () => {
        const { service, integrationConfigs } = build({
            rollout: { directByDefault: true },
        });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const realFindOne = integrationConfigs.findOne.getMockImplementation()!;
        integrationConfigs.findOne.mockImplementation(async (filter: any) => {
            if (filter.configKey === IntegrationConfigKey.EGRESS_FIXED_IP) {
                await gate; // the database answers after the mark
            }
            return realFindOne(filter);
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

    it('stores nothing when the team has no code management integration to hold it', async () => {
        const { service, integrationConfigs } = build({
            repositoriesIntegration: null,
        });
        await service.markFixedIpRequired(scope, 'ip_allow_list');
        expect(integrationConfigs.createOrUpdateConfig).not.toHaveBeenCalled();
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
        expect(parseEgressRollout({ fixedIp: 7 }).fixedIp).toBeUndefined();
    });

    it('keeps only string organization ids', () => {
        expect(
            parseEgressRollout({ directOrganizationIds: [ORG, 3, null, ''] })
                .directOrganizationIds,
        ).toEqual([ORG]);
    });
});
