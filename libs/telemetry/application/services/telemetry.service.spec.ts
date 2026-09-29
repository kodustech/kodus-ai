import { Test, TestingModule } from '@nestjs/testing';

import { N8nProvider } from '../../infrastructure/providers/n8n.provider';
import {
    IPostHogProvider,
    POSTHOG_PROVIDER_TOKEN,
} from '../../infrastructure/providers/posthog.provider';
import { ResendEventsProvider } from '../../infrastructure/providers/resend-events.provider';
import { TelemetryService } from './telemetry.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('TelemetryService — product events', () => {
    let service: TelemetryService;
    let posthog: jest.Mocked<Pick<IPostHogProvider, 'capture'>>;

    beforeEach(async () => {
        posthog = { capture: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TelemetryService,
                { provide: POSTHOG_PROVIDER_TOKEN, useValue: posthog },
                {
                    provide: ResendEventsProvider,
                    useValue: { send: jest.fn().mockResolvedValue(undefined) },
                },
                {
                    provide: N8nProvider,
                    useValue: { notify: jest.fn().mockResolvedValue(undefined) },
                },
            ],
        }).compile();

        service = module.get(TelemetryService);
    });

    const lastCall = () => posthog.capture.mock.calls.at(-1)!;

    describe('planChanged', () => {
        it('marks a paid plan so the conversion funnel has a step to end on', async () => {
            await service.planChanged({
                organizationId: 'org-1',
                teamId: 'team-1',
                planType: 'teams_byok',
                subscriptionStatus: 'active',
            });

            const [distinctId, event, properties, groups] = lastCall();
            expect(distinctId).toBe('org-1');
            expect(event).toBe('plan_changed');
            expect(properties).toMatchObject({
                planType: 'teams_byok',
                subscriptionStatus: 'active',
                isPaidPlan: true,
            });
            // Without the group the event can't be counted per organization,
            // which is the only unit a plan change happens in.
            expect(groups).toEqual({
                organization: 'org-1',
                team: 'team-1',
            });
        });

        it('does not call a free plan paid', async () => {
            await service.planChanged({
                organizationId: 'org-1',
                planType: 'free_byok',
                subscriptionStatus: 'active',
            });

            expect(lastCall()[2]).toMatchObject({ isPaidPlan: false });
        });

        it('does not call an unlicensed self-hosted install paid', async () => {
            await service.planChanged({
                organizationId: 'org-1',
                planType: 'self-hosted',
            });

            expect(lastCall()[2]).toMatchObject({ isPaidPlan: false });
        });
    });

    describe('creditsLow', () => {
        it('splits running out from running low — they are different moments', async () => {
            await service.creditsLow({
                organizationId: 'org-1',
                balanceUsd: 3,
                thresholdUsd: 5,
            });
            expect(lastCall()[1]).toBe('credits_low');

            await service.creditsLow({
                organizationId: 'org-1',
                balanceUsd: 0,
                exhausted: true,
            });
            expect(lastCall()[1]).toBe('credits_exhausted');
        });
    });

    describe('kodyRuleChanged', () => {
        it('names the event after the action so each one charts on its own', async () => {
            await service.kodyRuleChanged({
                organizationId: 'org-1',
                actorUserId: 'user-1',
                action: 'created',
                origin: 'manual',
                scope: 'repository',
                repositoryId: 'repo-1',
            });

            const [distinctId, event, properties, groups] = lastCall();
            expect(distinctId).toBe('user-1');
            expect(event).toBe('kody_rule_created');
            expect(properties).toMatchObject({
                origin: 'manual',
                scope: 'repository',
            });
            expect(groups).toMatchObject({
                organization: 'org-1',
                repository: 'repo-1',
            });
        });

        it('falls back to the organization when no actor is known', async () => {
            await service.kodyRuleChanged({
                organizationId: 'org-1',
                action: 'deleted',
            });

            expect(lastCall()[0]).toBe('org-1');
            expect(lastCall()[1]).toBe('kody_rule_deleted');
        });
    });

    describe('licenseSeatChanged', () => {
        it('separates assigning a seat from revoking one', async () => {
            await service.licenseSeatChanged({
                organizationId: 'org-1',
                targetGitId: '42',
                assigned: true,
                source: 'manual',
            });
            expect(lastCall()[1]).toBe('license_seat_assigned');

            await service.licenseSeatChanged({
                organizationId: 'org-1',
                targetGitId: '42',
                assigned: false,
                source: 'prune',
            });
            expect(lastCall()[1]).toBe('license_seat_revoked');
        });
    });

    describe('failure containment', () => {
        it('swallows a provider throw — telemetry never breaks the host flow', async () => {
            posthog.capture.mockImplementationOnce(() => {
                throw new Error('posthog exploded');
            });

            await expect(
                service.planChanged({ organizationId: 'org-1' }),
            ).resolves.toBeUndefined();
        });
    });
});
