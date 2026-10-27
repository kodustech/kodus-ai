import { TelemetryService } from './telemetry.service';

const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => mockLogger,
}));

describe('TelemetryService', () => {
    let service: TelemetryService;
    let posthog: {
        capture: jest.Mock;
        identify: jest.Mock;
        groupIdentify: jest.Mock;
    };
    let resend: { send: jest.Mock };
    let n8n: { notify: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        posthog = {
            capture: jest.fn(),
            identify: jest.fn(),
            groupIdentify: jest.fn(),
        };
        resend = { send: jest.fn().mockResolvedValue(undefined) };
        n8n = { notify: jest.fn().mockResolvedValue(undefined) };
        service = new TelemetryService(
            posthog as any,
            resend as any,
            n8n as any,
        );
    });

    const lastCall = () => posthog.capture.mock.calls.at(-1)!;

    describe('userSignedUp', () => {
        const payload = {
            userId: 'u-1',
            email: 'a@b.com',
            name: 'Alice',
            organizationId: 'org-1',
            organizationName: 'Acme',
            teamId: 'team-1',
            teamName: 'Eng',
        };

        it('identifies user, org group, team group, captures the event, sends to Resend and n8n', async () => {
            await service.userSignedUp(payload);

            expect(posthog.identify).toHaveBeenCalledWith('u-1', {
                email: 'a@b.com',
                name: 'Alice',
                organizationId: 'org-1',
                organizationName: 'Acme',
            });
            expect(posthog.groupIdentify).toHaveBeenCalledWith(
                'organization',
                'org-1',
                { id: 'org-1', name: 'Acme' },
            );
            expect(posthog.groupIdentify).toHaveBeenCalledWith(
                'team',
                'team-1',
                {
                    id: 'team-1',
                    name: 'Eng',
                    organizationId: 'org-1',
                    organizationName: 'Acme',
                },
            );
            expect(posthog.capture).toHaveBeenCalledWith(
                'u-1',
                'user_signed_up',
                expect.objectContaining({
                    email: 'a@b.com',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
                { organization: 'org-1', team: 'team-1' },
            );
            expect(resend.send).toHaveBeenCalledWith(
                'user.signed_up',
                'a@b.com',
                expect.objectContaining({
                    userId: 'u-1',
                    organizationName: 'Acme',
                }),
            );
            expect(n8n.notify).toHaveBeenCalledWith(
                'user.signed_up',
                expect.objectContaining({
                    userId: 'u-1',
                    email: 'a@b.com',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            );
        });

        it('skips team groupIdentify when teamId is absent', async () => {
            await service.userSignedUp({ ...payload, teamId: undefined });

            const teamCalls = posthog.groupIdentify.mock.calls.filter(
                (c) => c[0] === 'team',
            );
            expect(teamCalls).toHaveLength(0);
        });
    });

    it('sends byokConfigured only to PostHog (no Resend, no n8n)', async () => {
        await service.byokConfigured({
            userId: 'u-1',
            organizationId: 'org-1',
            provider: 'anthropic',
            slot: 'main',
        });

        expect(posthog.capture).toHaveBeenCalledWith(
            'u-1',
            'byok_configured',
            { organizationId: 'org-1', provider: 'anthropic', slot: 'main' },
            { organization: 'org-1' },
        );
        expect(resend.send).not.toHaveBeenCalled();
        expect(n8n.notify).not.toHaveBeenCalled();
    });

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
            expect(properties).toMatchObject({ isPaidPlan: true });
            // Without the group the event can't be counted per organization,
            // which is the only unit a plan change happens in.
            expect(groups).toEqual({
                organization: 'org-1',
                team: 'team-1',
            });
        });

        it('does not call a free plan or an unlicensed self-hosted install paid', async () => {
            await service.planChanged({
                organizationId: 'org-1',
                planType: 'free_byok',
                subscriptionStatus: 'active',
            });
            expect(lastCall()[2]).toMatchObject({ isPaidPlan: false });

            await service.planChanged({
                organizationId: 'org-1',
                planType: 'self-hosted',
            });
            expect(lastCall()[2]).toMatchObject({ isPaidPlan: false });
        });
    });

    it('splits running out of credits from running low — they are different moments', async () => {
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

    describe('distinctId', () => {
        it('uses the actor for kody rule changes and falls back to the organization', async () => {
            await service.kodyRuleChanged({
                organizationId: 'org-1',
                actorUserId: 'user-1',
                action: 'created',
                scope: 'repository',
                repositoryId: 'repo-1',
            });
            expect(lastCall()[0]).toBe('user-1');
            expect(lastCall()[1]).toBe('kody_rule_created');

            await service.kodyRuleChanged({
                organizationId: 'org-1',
                action: 'deleted',
            });
            expect(lastCall()[0]).toBe('org-1');
            expect(lastCall()[1]).toBe('kody_rule_deleted');
        });

        it('uses the owner for the first review and falls back to the organization', async () => {
            await service.firstReviewCompleted({
                organizationId: 'org-1',
                organizationName: 'Acme Corp',
                teamId: 'team-1',
                repositoryId: 'r-1',
                repositoryName: 'api-service',
                ownerId: 'owner-1',
                ownerEmail: 'owner@acme.com',
                orgMemberCount: 23,
            });
            expect(lastCall()[0]).toBe('owner-1');
            expect(lastCall()[3]).toEqual({
                organization: 'org-1',
                team: 'team-1',
                repository: 'r-1',
            });
            // n8n gets the hydrated payload for lead scoring.
            expect(n8n.notify).toHaveBeenCalledWith(
                'first_review.completed',
                expect.objectContaining({
                    organizationName: 'Acme Corp',
                    repositoryName: 'api-service',
                    ownerEmail: 'owner@acme.com',
                    ownerId: 'owner-1',
                    orgMemberCount: 23,
                }),
            );

            await service.firstReviewCompleted({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
            expect(lastCall()[0]).toBe('org-1');
            expect(resend.send).not.toHaveBeenCalled();
        });
    });

    it('sends onboarding completion to Resend only when there is an email', async () => {
        await service.onboardingCompleted({
            userId: 'u-1',
            organizationId: 'org-1',
            teamId: 'team-1',
            reviewedPR: false,
        });
        expect(posthog.capture).toHaveBeenCalledTimes(1);
        expect(n8n.notify).toHaveBeenCalledTimes(1);
        expect(resend.send).not.toHaveBeenCalled();

        await service.onboardingCompleted({
            userId: 'u-1',
            email: 'a@b.com',
            organizationId: 'org-1',
            teamId: 'team-1',
            reviewedPR: true,
        });
        expect(resend.send).toHaveBeenCalledWith(
            'onboarding.completed',
            'a@b.com',
            expect.objectContaining({ userId: 'u-1', reviewedPR: true }),
        );
    });

    // Telemetry must never break the host flow.
    describe('failure containment', () => {
        it('swallows a synchronous provider throw and logs a warning', async () => {
            posthog.capture.mockImplementationOnce(() => {
                throw new Error('posthog exploded');
            });

            await expect(
                service.planChanged({ organizationId: 'org-1' }),
            ).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Telemetry call "planChanged" failed',
                    ),
                }),
            );
        });

        it('swallows an async provider rejection', async () => {
            n8n.notify.mockRejectedValueOnce(new Error('n8n died'));

            await expect(
                service.firstReviewCompleted({ organizationId: 'org-1' }),
            ).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });
    });
});
