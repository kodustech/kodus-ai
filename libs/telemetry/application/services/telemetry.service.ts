import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { N8nProvider } from '../../infrastructure/providers/n8n.provider';
import {
    IPostHogProvider,
    POSTHOG_PROVIDER_TOKEN,
} from '../../infrastructure/providers/posthog.provider';
import { ResendEventsProvider } from '../../infrastructure/providers/resend-events.provider';

/**
 * Single entry point for product telemetry. One method per business event.
 *
 * Telemetry must NEVER break the host flow — every public method runs through
 * `safeCall`, which catches throws/rejections from any provider and logs them.
 * Callers can fire-and-forget without try/catch.
 */
@Injectable()
export class TelemetryService {
    private readonly logger = createLogger(TelemetryService.name);

    constructor(
        @Inject(POSTHOG_PROVIDER_TOKEN)
        private readonly posthog: IPostHogProvider,
        private readonly resend: ResendEventsProvider,
        private readonly n8n: N8nProvider,
    ) {}

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    async userSignedUp(p: {
        userId: string;
        email: string;
        name?: string;
        organizationId: string;
        organizationName?: string;
        teamId?: string;
        teamName?: string;
    }): Promise<void> {
        await this.safeCall('userSignedUp', async () => {
            this.posthog.identify(p.userId, {
                email: p.email,
                name: p.name,
                organizationId: p.organizationId,
                organizationName: p.organizationName,
            });

            this.posthog.groupIdentify('organization', p.organizationId, {
                id: p.organizationId,
                name: p.organizationName,
            });

            if (p.teamId) {
                this.posthog.groupIdentify('team', p.teamId, {
                    id: p.teamId,
                    name: p.teamName,
                    organizationId: p.organizationId,
                    organizationName: p.organizationName,
                });
            }

            this.posthog.capture(
                p.userId,
                'user_signed_up',
                {
                    email: p.email,
                    name: p.name,
                    organizationId: p.organizationId,
                    organizationName: p.organizationName,
                    teamId: p.teamId,
                },
                { organization: p.organizationId, team: p.teamId },
            );

            await this.resend.send('user.signed_up', p.email, {
                userId: p.userId,
                name: p.name,
                organizationName: p.organizationName,
            });

            await this.n8n.notify('user.signed_up', {
                userId: p.userId,
                email: p.email,
                name: p.name,
                organizationId: p.organizationId,
                organizationName: p.organizationName,
                teamId: p.teamId,
                teamName: p.teamName,
            });
        });
    }

    async userInvitationAccepted(p: {
        userId: string;
        email: string;
        name?: string;
        organizationId?: string;
        teamId?: string;
    }): Promise<void> {
        await this.safeCall('userInvitationAccepted', async () => {
            this.posthog.identify(p.userId, {
                email: p.email,
                name: p.name,
                organizationId: p.organizationId,
            });

            this.posthog.capture(
                p.userId,
                'user_invitation_accepted',
                {
                    email: p.email,
                    name: p.name,
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                },
                { organization: p.organizationId, team: p.teamId },
            );

            await this.resend.send('user.invitation_accepted', p.email, {
                userId: p.userId,
                name: p.name,
            });
        });
    }

    async organizationUpdated(p: {
        organizationId: string;
        name?: string;
        tenantName?: string;
    }): Promise<void> {
        await this.safeCall('organizationUpdated', () => {
            this.posthog.groupIdentify('organization', p.organizationId, {
                id: p.organizationId,
                name: p.name,
                tenantName: p.tenantName,
            });
        });
    }

    async teamCreated(p: {
        teamId: string;
        name?: string;
        organizationId?: string;
        organizationName?: string;
        actorUserId?: string;
    }): Promise<void> {
        await this.safeCall('teamCreated', () => {
            this.posthog.groupIdentify('team', p.teamId, {
                id: p.teamId,
                name: p.name,
                organizationId: p.organizationId,
                organizationName: p.organizationName,
            });

            if (p.actorUserId) {
                this.posthog.capture(
                    p.actorUserId,
                    'team_created',
                    {
                        teamId: p.teamId,
                        name: p.name,
                        organizationId: p.organizationId,
                    },
                    { organization: p.organizationId, team: p.teamId },
                );
            }
        });
    }

    async repositoryConnected(p: {
        repositoryId: string;
        name: string;
        fullName: string;
        platform: string;
        organizationId: string;
        agentReviewEnabled?: boolean;
        actorUserId?: string;
    }): Promise<void> {
        await this.safeCall('repositoryConnected', () => {
            this.posthog.groupIdentify('repository', p.repositoryId, {
                repositoryId: p.repositoryId,
                name: p.name,
                fullName: p.fullName,
                platform: p.platform,
                organizationId: p.organizationId,
                agentReviewEnabled: p.agentReviewEnabled ?? false,
            });

            if (p.actorUserId) {
                this.posthog.capture(
                    p.actorUserId,
                    'repository_connected',
                    {
                        repositoryId: p.repositoryId,
                        fullName: p.fullName,
                        platform: p.platform,
                        organizationId: p.organizationId,
                    },
                    {
                        organization: p.organizationId,
                        repository: p.repositoryId,
                    },
                );
            }
        });
    }

    // ─── Product milestones ─────────────────────────────────────────────────

    async byokConfigured(p: {
        userId: string;
        organizationId: string;
        provider?: string;
        slot?: 'main' | 'fallback';
    }): Promise<void> {
        await this.safeCall('byokConfigured', () => {
            this.posthog.capture(
                p.userId,
                'byok_configured',
                {
                    organizationId: p.organizationId,
                    provider: p.provider,
                    slot: p.slot,
                },
                { organization: p.organizationId },
            );
        });
    }

    async onboardingCompleted(p: {
        userId: string;
        email?: string;
        organizationId: string;
        organizationName?: string;
        teamId: string;
        teamName?: string;
        reviewedPR: boolean;
    }): Promise<void> {
        await this.safeCall('onboardingCompleted', async () => {
            this.posthog.capture(
                p.userId,
                'onboarding_completed',
                {
                    organizationId: p.organizationId,
                    organizationName: p.organizationName,
                    teamId: p.teamId,
                    teamName: p.teamName,
                    reviewedPR: p.reviewedPR,
                },
                { organization: p.organizationId, team: p.teamId },
            );

            if (p.email) {
                await this.resend.send('onboarding.completed', p.email, {
                    userId: p.userId,
                    organizationName: p.organizationName,
                    reviewedPR: p.reviewedPR,
                });
            }

            await this.n8n.notify('onboarding.completed', {
                userId: p.userId,
                email: p.email,
                organizationId: p.organizationId,
                organizationName: p.organizationName,
                teamId: p.teamId,
                teamName: p.teamName,
                reviewedPR: p.reviewedPR,
            });
        });
    }

    /**
     * The user clicked "review this PR" during onboarding. Reflects intent at
     * onboarding time, not the actual completion of a review — see
     * `firstReviewCompleted` for the org-level "aha moment" milestone.
     */
    async onboardingReviewTriggered(p: {
        userId: string;
        email?: string;
        teamId: string;
        organizationId?: string;
        repositoryId?: string;
    }): Promise<void> {
        await this.safeCall('onboardingReviewTriggered', async () => {
            this.posthog.capture(
                p.userId,
                'onboarding_review_triggered',
                {
                    teamId: p.teamId,
                    organizationId: p.organizationId,
                    repositoryId: p.repositoryId,
                },
                {
                    organization: p.organizationId,
                    team: p.teamId,
                    repository: p.repositoryId,
                },
            );

            if (p.email) {
                await this.resend.send('onboarding.review_triggered', p.email, {
                    userId: p.userId,
                    repositoryId: p.repositoryId,
                });
            }
        });
    }

    async onboardingReviewSkipped(p: {
        userId: string;
        email?: string;
        teamId: string;
        organizationId?: string;
    }): Promise<void> {
        await this.safeCall('onboardingReviewSkipped', async () => {
            this.posthog.capture(
                p.userId,
                'onboarding_review_skipped',
                { teamId: p.teamId, organizationId: p.organizationId },
                { organization: p.organizationId, team: p.teamId },
            );

            if (p.email) {
                await this.resend.send('onboarding.review_skipped', p.email, {
                    userId: p.userId,
                });
            }
        });
    }

    /**
     * Fires once per organization, the first time a code review pipeline
     * completes successfully (any trigger source: webhook, onboarding, CLI).
     * The caller is responsible for atomic deduplication — see
     * `OrganizationParametersKey.FIRST_REVIEW_AT`.
     */
    async firstReviewCompleted(p: {
        organizationId: string;
        organizationName?: string;
        teamId?: string;
        repositoryId?: string;
        repositoryName?: string;
        pullRequestNumber?: number;
        platform?: string;
        ownerId?: string;
        ownerEmail?: string;
    }): Promise<void> {
        await this.safeCall('firstReviewCompleted', async () => {
            this.posthog.capture(
                p.ownerId ?? p.organizationId,
                'first_review_completed',
                {
                    organizationId: p.organizationId,
                    organizationName: p.organizationName,
                    teamId: p.teamId,
                    repositoryId: p.repositoryId,
                    repositoryName: p.repositoryName,
                    pullRequestNumber: p.pullRequestNumber,
                    platform: p.platform,
                    ownerEmail: p.ownerEmail,
                },
                {
                    organization: p.organizationId,
                    team: p.teamId,
                    repository: p.repositoryId,
                },
            );

            await this.n8n.notify('first_review.completed', {
                organizationId: p.organizationId,
                organizationName: p.organizationName,
                teamId: p.teamId,
                repositoryId: p.repositoryId,
                repositoryName: p.repositoryName,
                pullRequestNumber: p.pullRequestNumber,
                platform: p.platform,
                ownerEmail: p.ownerEmail,
                ownerId: p.ownerId,
            });
        });
    }

    /**
     * Last line of defense: any throw/rejection from a provider is caught
     * here, logged as a warning, and swallowed. Telemetry never breaks the
     * host flow.
     */
    private async safeCall(
        label: string,
        fn: () => Promise<void> | void,
    ): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.warn({
                message: `Telemetry call "${label}" failed (swallowed)`,
                context: TelemetryService.name,
                metadata: {
                    label,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
}
