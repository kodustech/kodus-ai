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

    it('asks billing again on the next sandbox when it could not answer', async () => {
        const { service, licenseService } = build({
            rollout: on,
            license: 'unavailable',
        });
        await service.route(scope);
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

        const setting = await service.setFixedIp(scope, true, 'user-1');

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
        await expect(service.setFixedIp(scope, true)).rejects.toBeInstanceOf(
            FixedEgressIpPlanRequiredError,
        );
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
                service.setFixedIp(scope, true),
            ).rejects.toBeInstanceOf(FixedEgressIpPlanUnconfirmedError);
            expect(
                integrationConfigs.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        }
    });

    it('says the plan is unconfirmed while billing cannot answer, and not once it does', async () => {
        const down = build({ rollout: on, license: 'unavailable' });
        await expect(down.service.getFixedIpSetting(scope)).resolves.toEqual(
            expect.objectContaining({ planUnconfirmed: true }),
        );
        const up = build({ rollout: on, license: 'teams' });
        const setting = await up.service.getFixedIpSetting(scope);
        expect(setting.planUnconfirmed).toBeUndefined();
    });

    it('lets a team turn it off while billing cannot say the plan', async () => {
        const { service, integrationConfigs } = build({
            rollout: on,
            license: 'unavailable',
        });
        await service.setFixedIp(scope, false);
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
        await service.setFixedIp(scope, false);
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
        await expect(service.getFixedIpSetting(scope)).resolves.toEqual(
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
        await expect(service.getFixedIpSetting(scope)).resolves.toEqual(
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
