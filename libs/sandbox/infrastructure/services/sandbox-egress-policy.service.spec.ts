import { Test } from '@nestjs/testing';

import { CacheService } from '@libs/core/cache/cache.service';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

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
    const service = new SandboxEgressPolicyService(
        globalParameters as any,
        integrationConfigs as any,
        cache as any,
    );
    return { service, globalParameters, integrationConfigs, cache };
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

    it('keeps only string organization ids', () => {
        expect(
            parseEgressRollout({ directOrganizationIds: [ORG, 3, null, ''] })
                .directOrganizationIds,
        ).toEqual([ORG]);
    });
});
