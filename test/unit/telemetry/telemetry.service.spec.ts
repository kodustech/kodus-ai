import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import { N8nProvider } from '@libs/telemetry/infrastructure/providers/n8n.provider';
import { PostHogProvider } from '@libs/telemetry/infrastructure/providers/posthog.provider';
import { ResendEventsProvider } from '@libs/telemetry/infrastructure/providers/resend-events.provider';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

type Mocked<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? jest.Mock<R, A>
        : T[K];
};

const buildProviders = () => {
    const posthog: Mocked<
        Pick<PostHogProvider, 'capture' | 'identify' | 'groupIdentify'>
    > = {
        capture: jest.fn(),
        identify: jest.fn(),
        groupIdentify: jest.fn(),
    };
    const resend: Mocked<Pick<ResendEventsProvider, 'send'>> = {
        send: jest.fn().mockResolvedValue(undefined),
    };
    const n8n: Mocked<Pick<N8nProvider, 'notify'>> = {
        notify: jest.fn().mockResolvedValue(undefined),
    };
    return { posthog, resend, n8n };
};

const buildService = () => {
    const providers = buildProviders();
    const service = new TelemetryService(
        providers.posthog as any,
        providers.resend as any,
        providers.n8n as any,
    );
    return { service, ...providers };
};

describe('TelemetryService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ─── userSignedUp ───────────────────────────────────────────────────
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
            const { service, posthog, resend, n8n } = buildService();

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
            const { service, posthog } = buildService();

            await service.userSignedUp({ ...payload, teamId: undefined });

            const teamCalls = posthog.groupIdentify.mock.calls.filter(
                (c) => c[0] === 'team',
            );
            expect(teamCalls).toHaveLength(0);
        });
    });

    // ─── byokConfigured ─────────────────────────────────────────────────
    describe('byokConfigured', () => {
        it('only fires PostHog (no Resend, no n8n)', async () => {
            const { service, posthog, resend, n8n } = buildService();

            await service.byokConfigured({
                userId: 'u-1',
                organizationId: 'org-1',
                provider: 'anthropic',
                slot: 'main',
            });

            expect(posthog.capture).toHaveBeenCalledWith(
                'u-1',
                'byok_configured',
                {
                    organizationId: 'org-1',
                    provider: 'anthropic',
                    slot: 'main',
                },
                { organization: 'org-1' },
            );
            expect(resend.send).not.toHaveBeenCalled();
            expect(n8n.notify).not.toHaveBeenCalled();
        });
    });

    // ─── firstReviewCompleted ───────────────────────────────────────────
    describe('firstReviewCompleted', () => {
        const fullPayload = {
            organizationId: 'org-1',
            organizationName: 'Acme Corp',
            teamId: 'team-1',
            repositoryId: 'r-1',
            repositoryName: 'api-service',
            pullRequestNumber: 42,
            platform: 'github',
            ownerId: 'owner-1',
            ownerEmail: 'owner@acme.com',
        };

        it('uses ownerId as distinctId when present, fires PostHog and n8n with hydrated payload, skips Resend', async () => {
            const { service, posthog, resend, n8n } = buildService();

            await service.firstReviewCompleted(fullPayload);

            // Owner becomes the PostHog distinctId so events tie to a real user.
            expect(posthog.capture).toHaveBeenCalledWith(
                'owner-1',
                'first_review_completed',
                expect.objectContaining({
                    organizationId: 'org-1',
                    organizationName: 'Acme Corp',
                    repositoryName: 'api-service',
                    ownerEmail: 'owner@acme.com',
                    pullRequestNumber: 42,
                }),
                {
                    organization: 'org-1',
                    team: 'team-1',
                    repository: 'r-1',
                },
            );
            expect(n8n.notify).toHaveBeenCalledWith(
                'first_review.completed',
                expect.objectContaining({
                    organizationId: 'org-1',
                    organizationName: 'Acme Corp',
                    repositoryName: 'api-service',
                    ownerEmail: 'owner@acme.com',
                    ownerId: 'owner-1',
                }),
            );
            expect(resend.send).not.toHaveBeenCalled();
        });

        it('falls back to organizationId as distinctId when ownerId is missing', async () => {
            const { service, posthog } = buildService();

            await service.firstReviewCompleted({
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(posthog.capture.mock.calls[0][0]).toBe('org-1');
        });
    });

    describe('onboardingCompleted', () => {
        it('skips Resend when no email is given but still fires PostHog and n8n', async () => {
            const { service, posthog, resend, n8n } = buildService();

            await service.onboardingCompleted({
                userId: 'u-1',
                organizationId: 'org-1',
                teamId: 'team-1',
                reviewedPR: false,
            });

            expect(posthog.capture).toHaveBeenCalledTimes(1);
            expect(n8n.notify).toHaveBeenCalledTimes(1);
            expect(resend.send).not.toHaveBeenCalled();
        });

        it('sends to Resend when email is provided', async () => {
            const { service, resend } = buildService();

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
    });

    // ─── safeCall — the core invariant ──────────────────────────────────
    // Telemetry MUST NEVER break the host flow. Even if a provider
    // misbehaves (sync throw, async rejection, weird state), the public
    // method resolves normally and a warn is logged.
    describe('safeCall (resilience invariant)', () => {
        it('swallows synchronous throws from PostHog and resolves', async () => {
            const { service, posthog } = buildService();
            posthog.capture.mockImplementation(() => {
                throw new Error('posthog blew up');
            });

            await expect(
                service.byokConfigured({
                    userId: 'u-1',
                    organizationId: 'org-1',
                }),
            ).resolves.toBeUndefined();

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn.mock.calls[0][0].message).toContain(
                'Telemetry call "byokConfigured" failed',
            );
        });

        it('swallows async rejection from Resend and resolves', async () => {
            const { service, resend } = buildService();
            resend.send.mockRejectedValueOnce(new Error('resend died'));

            await expect(
                service.userSignedUp({
                    userId: 'u-1',
                    email: 'a@b.com',
                    organizationId: 'org-1',
                }),
            ).resolves.toBeUndefined();

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Telemetry call "userSignedUp" failed',
                    ),
                }),
            );
        });

        it('swallows async rejection from n8n and resolves', async () => {
            const { service, n8n } = buildService();
            n8n.notify.mockRejectedValueOnce(new Error('n8n died'));

            await expect(
                service.firstReviewCompleted({ organizationId: 'org-1' }),
            ).resolves.toBeUndefined();

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Telemetry call "firstReviewCompleted" failed',
                    ),
                }),
            );
        });
    });
});
