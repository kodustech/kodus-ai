import { BadRequestException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { NotificationEvent } from '../domain/catalog/events';
import { IRoutingRuleRepository } from '../domain/contracts/routing-rule.repository.contract';
import { RoutingRuleService } from './routing-rule.service';

describe('RoutingRuleService', () => {
    let routingRuleRepo: jest.Mocked<IRoutingRuleRepository>;
    let service: RoutingRuleService;

    beforeEach(() => {
        routingRuleRepo = {
            findByOrganization: jest.fn().mockResolvedValue([]),
            resolve: jest.fn(),
            upsert: jest.fn(),
            upsertBatch: jest.fn().mockResolvedValue([]),
            deleteByOrganization: jest.fn().mockResolvedValue(0),
            deleteByOrgEventRole: jest.fn().mockResolvedValue(1),
        };
        service = new RoutingRuleService(routingRuleRepo);
    });

    describe('upsertRules — validation', () => {
        it('rejects any upsert that targets a SYSTEM event', async () => {
            await expect(
                service.upsertRules('org-1', [
                    {
                        // AUTH_FORGOT_PASSWORD is SYSTEM in the catalog
                        event: NotificationEvent.AUTH_FORGOT_PASSWORD,
                        role: '*',
                        channels: { email: true, in_app: false },
                    },
                ]),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(routingRuleRepo.upsertBatch).not.toHaveBeenCalled();
        });

        it('allows muting a channel on a CRITICAL event (lock removed)', async () => {
            // BILLING_PAYMENT_FAILED is CRITICAL — disabling in_app used to be
            // rejected; it now passes straight through to upsertBatch.
            await service.upsertRules('org-1', [
                {
                    event: NotificationEvent.BILLING_PAYMENT_FAILED,
                    role: Role.OWNER,
                    channels: { email: true, in_app: false },
                },
            ]);

            expect(routingRuleRepo.upsertBatch).toHaveBeenCalledWith([
                expect.objectContaining({
                    event: NotificationEvent.BILLING_PAYMENT_FAILED,
                    role: Role.OWNER,
                    channels: { email: true, in_app: false },
                }),
            ]);
        });

        it('rejects a delete that targets the wildcard role', async () => {
            await expect(
                service.upsertRules('org-1', [
                    {
                        event: NotificationEvent.KODY_RULES_GENERATED,
                        role: '*',
                        channels: { email: true, in_app: true },
                        delete: true,
                    },
                ]),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('routes deletes to deleteByOrgEventRole and skips them from upsertBatch', async () => {
            await service.upsertRules('org-1', [
                {
                    event: NotificationEvent.KODY_RULES_GENERATED,
                    role: Role.OWNER,
                    channels: { email: true, in_app: true },
                    delete: true,
                },
            ]);

            expect(routingRuleRepo.deleteByOrgEventRole).toHaveBeenCalledWith(
                'org-1',
                NotificationEvent.KODY_RULES_GENERATED,
                Role.OWNER,
            );
            expect(routingRuleRepo.upsertBatch).not.toHaveBeenCalled();
        });

        it('passes upserts through to upsertBatch with the catalog category', async () => {
            await service.upsertRules('org-1', [
                {
                    event: NotificationEvent.KODY_RULES_GENERATED,
                    role: Role.OWNER,
                    channels: { email: true, in_app: false },
                },
            ]);

            expect(routingRuleRepo.upsertBatch).toHaveBeenCalledWith([
                expect.objectContaining({
                    organization: { uuid: 'org-1' },
                    event: NotificationEvent.KODY_RULES_GENERATED,
                    role: Role.OWNER,
                    category: 'kody_rules',
                    channels: { email: true, in_app: false },
                }),
            ]);
        });
    });

    describe('getConfig', () => {
        it('returns events, channels, criticalities, categories, and roles', () => {
            const config = service.getConfig();

            expect(config.events.length).toBeGreaterThan(0);

            // Channels: just the two MVP-active ones
            expect(config.channels.map((c) => c.value).sort()).toEqual([
                'email',
                'in_app',
            ]);

            // Criticalities: all 4 from the enum
            expect(config.criticalities.map((c) => c.value).sort()).toEqual([
                'critical',
                'informational',
                'system',
                'transactional',
            ]);

            // Roles: wildcard first, then enum members
            expect(config.roles[0]).toEqual({
                value: '*',
                label: 'All Roles',
            });
            expect(config.roles.map((r) => r.value)).toContain(Role.OWNER);
        });

        it('only declares pageSeverity for CRITICAL events', () => {
            const config = service.getConfig();
            for (const event of config.events) {
                if (event.criticality !== 'critical') {
                    expect(event.pageSeverity).toBeUndefined();
                }
            }
        });
    });

    describe('seedDefaults', () => {
        it('skips SYSTEM events (no rule rows created for them)', async () => {
            await service.seedDefaults('org-1');

            const upsertedEvents =
                routingRuleRepo.upsertBatch.mock.calls[0][0].map(
                    (r) => r.event,
                );
            expect(upsertedEvents).not.toContain(
                NotificationEvent.AUTH_FORGOT_PASSWORD,
            );
            expect(upsertedEvents).not.toContain(
                NotificationEvent.SSO_DOMAIN_VERIFICATION,
            );
        });

        it('seeds an off "*" baseline + default-role overrides for role-fanout events', async () => {
            await service.seedDefaults('org-1');

            const calls = routingRuleRepo.upsertBatch.mock.calls[0][0];
            // BILLING_PAYMENT_FAILED has defaultRoles [owner, billing_manager].
            const billing = calls.filter(
                (r) => r.event === NotificationEvent.BILLING_PAYMENT_FAILED,
            );
            const wildcard = billing.find((r) => r.role === '*');
            expect(wildcard?.channels).toEqual({});
            expect(
                billing.find((r) => r.role === Role.OWNER)?.channels,
            ).toEqual({ email: true, in_app: true });
            expect(
                billing.find((r) => r.role === Role.BILLING_MANAGER)?.channels,
            ).toEqual({ email: true, in_app: true });
        });

        it('seeds a "*" row carrying catalog defaults for directed events', async () => {
            await service.seedDefaults('org-1');

            const calls = routingRuleRepo.upsertBatch.mock.calls[0][0];
            // KODY_RULES_GENERATED has no defaultRoles (directed at users).
            const kody = calls.filter(
                (r) => r.event === NotificationEvent.KODY_RULES_GENERATED,
            );
            expect(kody).toHaveLength(1);
            expect(kody[0].role).toBe('*');
            expect(kody[0].channels).toEqual({ email: true, in_app: true });
        });
    });

    describe('resetToDefaults', () => {
        it('wipes existing rules before re-seeding', async () => {
            await service.resetToDefaults('org-1');

            expect(routingRuleRepo.deleteByOrganization).toHaveBeenCalledWith(
                'org-1',
            );
            expect(routingRuleRepo.upsertBatch).toHaveBeenCalled();
        });
    });
});
