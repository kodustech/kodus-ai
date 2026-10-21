import { createLogger } from '@libs/core/log/logger';
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
/**
 * Whether a plan type is one the org pays for. Anything that is not the
 * free tier and not an unlicensed self-hosted install is paid.
 */
const isPaidPlanType = (planType?: string): boolean =>
    !!planType && !planType.startsWith('free') && planType !== 'self-hosted';

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
        /**
         * Real engineering team size from the just-connected git org (member
         * count). Enriched at the call site — only Kodus holds the per-org git
         * auth to fetch it — and forwarded to n8n for lead scoring.
         */
        orgMemberCount?: number;
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
                    orgMemberCount: p.orgMemberCount,
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
                orgMemberCount: p.orgMemberCount,
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
        /**
         * Real engineering team size from the connected git org (member
         * count). Only Kodus holds the per-org git auth to fetch this, so it's
         * enriched at the call site and forwarded here for lead scoring in n8n.
         */
        orgMemberCount?: number;
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
                    orgMemberCount: p.orgMemberCount,
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
                orgMemberCount: p.orgMemberCount,
            });
        });
    }

    // ─── Billing (inbound webhooks from kodus-service-billing) ──────────────

    /**
     * The org's plan changed — the closing step of the paywall funnel
     * (`gate_hit` → `gate_cta_click` → `checkout_started` → here).
     *
     * These arrive as webhooks, so no user id is attached: checkout happens
     * on Stripe's page, not ours. The organization id stands in as the
     * distinct id (the same fallback `firstReviewCompleted` uses) and the
     * organization group is what stitches them back to user-level events.
     *
     * The webhook carries the new plan, never the previous one, so this
     * cannot honestly claim an upgrade. It reports the plan the org landed
     * on plus `isPaidPlan`; a conversion funnel asks for `isPaidPlan=true`.
     */
    async planChanged(p: {
        organizationId: string;
        teamId?: string;
        planType?: string;
        subscriptionStatus?: string;
    }): Promise<void> {
        await this.safeCall('planChanged', () => {
            this.posthog.capture(
                p.organizationId,
                'plan_changed',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    planType: p.planType,
                    subscriptionStatus: p.subscriptionStatus,
                    isPaidPlan: isPaidPlanType(p.planType),
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** A charge failed. Reviews keep running until billing says otherwise. */
    async paymentFailed(p: {
        organizationId: string;
        amount?: number;
        currency?: string;
        failureReason?: string;
    }): Promise<void> {
        await this.safeCall('paymentFailed', () => {
            this.posthog.capture(
                p.organizationId,
                'payment_failed',
                {
                    organizationId: p.organizationId,
                    amount: p.amount,
                    currency: p.currency,
                    failureReason: p.failureReason,
                },
                { organization: p.organizationId },
            );
        });
    }

    /** Billing warned the trial is ending; `daysRemaining` is the horizon. */
    async trialExpiring(p: {
        organizationId: string;
        daysRemaining?: number;
        trialEndsAt?: string;
    }): Promise<void> {
        await this.safeCall('trialExpiring', () => {
            this.posthog.capture(
                p.organizationId,
                'trial_expiring',
                {
                    organizationId: p.organizationId,
                    daysRemaining: p.daysRemaining,
                    trialEndsAt: p.trialEndsAt,
                },
                { organization: p.organizationId },
            );
        });
    }

    /** A credit top-up cleared. */
    async creditsPurchased(p: {
        organizationId: string;
        teamId?: string;
        creditUsd?: number;
        balanceUsd?: number;
    }): Promise<void> {
        await this.safeCall('creditsPurchased', () => {
            this.posthog.capture(
                p.organizationId,
                'credits_purchased',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    creditUsd: p.creditUsd,
                    balanceUsd: p.balanceUsd,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /**
     * Two events, not one with a flag: running low is a nudge, running out
     * stops every review the org has queued. They belong to different
     * funnels, and charting them apart is the point.
     */
    async creditsLow(p: {
        organizationId: string;
        teamId?: string;
        balanceUsd?: number;
        thresholdUsd?: number;
        exhausted?: boolean;
    }): Promise<void> {
        await this.safeCall('creditsLow', () => {
            this.posthog.capture(
                p.organizationId,
                p.exhausted ? 'credits_exhausted' : 'credits_low',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    balanceUsd: p.balanceUsd,
                    thresholdUsd: p.thresholdUsd,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** A self-hosted install activated a license key. */
    async licenseActivated(p: {
        organizationId: string;
        userId?: string;
        planType?: string;
        expiresAt?: string;
    }): Promise<void> {
        await this.safeCall('licenseActivated', () => {
            this.posthog.capture(
                p.userId ?? p.organizationId,
                'license_activated',
                {
                    organizationId: p.organizationId,
                    planType: p.planType,
                    expiresAt: p.expiresAt,
                },
                { organization: p.organizationId },
            );
        });
    }

    /**
     * A review seat was given to or taken from a person. Seats are what
     * Teams bills on, so assignment volume is the usage side of revenue.
     */
    async licenseSeatChanged(p: {
        organizationId: string;
        actorUserId?: string;
        targetGitId?: string;
        assigned: boolean;
        source: 'manual' | 'auto' | 'prune';
        seatsUsed?: number;
        seatsTotal?: number;
    }): Promise<void> {
        await this.safeCall('licenseSeatChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                p.assigned ? 'license_seat_assigned' : 'license_seat_revoked',
                {
                    organizationId: p.organizationId,
                    targetGitId: p.targetGitId,
                    source: p.source,
                    seatsUsed: p.seatsUsed,
                    seatsTotal: p.seatsTotal,
                },
                { organization: p.organizationId },
            );
        });
    }

    /** The trial clock started for a team. */
    async trialStarted(p: {
        organizationId: string;
        teamId?: string;
        userId?: string;
        trialEndsAt?: string;
    }): Promise<void> {
        await this.safeCall('trialStarted', () => {
            this.posthog.capture(
                p.userId ?? p.organizationId,
                'trial_started',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    trialEndsAt: p.trialEndsAt,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    // ─── Activation ─────────────────────────────────────────────────────────

    /**
     * Somebody came back. `method` separates password from OAuth from SSO,
     * which is the only way to see whether SSO is actually being used after
     * an org configures it.
     */
    async userLoggedIn(p: {
        userId: string;
        organizationId?: string;
        teamId?: string;
        method: 'password' | 'oauth' | 'sso';
        provider?: string;
    }): Promise<void> {
        await this.safeCall('userLoggedIn', () => {
            this.posthog.capture(
                p.userId,
                'user_logged_in',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    method: p.method,
                    provider: p.provider,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** "How did you hear about us", answered during setup. */
    async marketingSurveyAnswered(p: {
        userId: string;
        organizationId?: string;
        source?: string;
        details?: string;
    }): Promise<void> {
        await this.safeCall('marketingSurveyAnswered', () => {
            this.posthog.capture(
                p.userId,
                'marketing_survey_answered',
                {
                    organizationId: p.organizationId,
                    source: p.source,
                    details: p.details,
                },
                { organization: p.organizationId },
            );
        });
    }

    /**
     * A git provider was connected — the step before repositories exist.
     * `repositoryConnected` fires once per repo afterwards; this fires once
     * per provider, which is what the setup funnel counts.
     */
    async gitIntegrationChanged(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        platform?: string;
        connected: boolean;
        authMode?: string;
    }): Promise<void> {
        await this.safeCall('gitIntegrationChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                p.connected
                    ? 'git_integration_connected'
                    : 'git_integration_disconnected',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    platform: p.platform,
                    authMode: p.authMode,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /**
     * The repository selection was saved. One event per save with the
     * counts, next to the per-repo `repository_connected` events: the funnel
     * step is "picked repos", not "picked the seventh repo".
     */
    async repositoriesSelected(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        platform?: string;
        selectedCount: number;
        addedCount?: number;
        removedCount?: number;
    }): Promise<void> {
        await this.safeCall('repositoriesSelected', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'repositories_selected',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    platform: p.platform,
                    selectedCount: p.selectedCount,
                    addedCount: p.addedCount,
                    removedCount: p.removedCount,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** Someone joined an organization that already existed. */
    async organizationJoined(p: {
        userId: string;
        organizationId: string;
        teamId?: string;
        via: 'invite' | 'domain' | 'request';
    }): Promise<void> {
        await this.safeCall('organizationJoined', () => {
            this.posthog.capture(
                p.userId,
                'organization_joined',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    via: p.via,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    // ─── Feature usage ──────────────────────────────────────────────────────

    /**
     * A Kody Rule changed. One method for the whole lifecycle because the
     * interesting cut is `action` × `origin` — a rule typed by hand and a
     * rule imported from the library are the same object with very
     * different acquisition stories.
     */
    async kodyRuleChanged(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        action: 'created' | 'updated' | 'deleted' | 'status_changed';
        origin?: string;
        scope?: 'global' | 'repository' | 'directory';
        repositoryId?: string;
        status?: string;
        ruleCount?: number;
    }): Promise<void> {
        await this.safeCall('kodyRuleChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                `kody_rule_${p.action}`,
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    origin: p.origin,
                    scope: p.scope,
                    repositoryId: p.repositoryId,
                    status: p.status,
                    ruleCount: p.ruleCount,
                },
                {
                    organization: p.organizationId,
                    team: p.teamId,
                    repository: p.repositoryId,
                },
            );
        });
    }

    /**
     * Rules arrived in bulk. `source` says where from: the public library,
     * the codebase discovery run, an IDE folder, or a fast import.
     */
    async kodyRulesImported(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        source: 'library' | 'discovery' | 'ide' | 'fast_import' | 'global_sync';
        ruleCount: number;
        repositoryCount?: number;
    }): Promise<void> {
        await this.safeCall('kodyRulesImported', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'kody_rules_imported',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    source: p.source,
                    ruleCount: p.ruleCount,
                    repositoryCount: p.repositoryCount,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** A plugin (MCP connection) was installed or removed. */
    async pluginChanged(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        pluginId?: string;
        pluginName?: string;
        provider?: string;
        installed: boolean;
        toolCount?: number;
    }): Promise<void> {
        await this.safeCall('pluginChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                p.installed ? 'plugin_installed' : 'plugin_removed',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    pluginId: p.pluginId,
                    pluginName: p.pluginName,
                    provider: p.provider,
                    toolCount: p.toolCount,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /**
     * Code review configuration was saved. `configLevel` separates the org
     * default from a repository or directory override — the three read very
     * differently in a funnel, and only the first is part of setup.
     */
    async codeReviewSettingsUpdated(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        configLevel?: string;
        repositoryId?: string;
        section?: string;
    }): Promise<void> {
        await this.safeCall('codeReviewSettingsUpdated', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'code_review_settings_updated',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    configLevel: p.configLevel,
                    repositoryId: p.repositoryId,
                    section: p.section,
                },
                {
                    organization: p.organizationId,
                    team: p.teamId,
                    repository: p.repositoryId,
                },
            );
        });
    }

    /** Somebody was invited to the organization. */
    async memberInvited(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        invitedCount: number;
        role?: string;
    }): Promise<void> {
        await this.safeCall('memberInvited', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'member_invited',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    invitedCount: p.invitedCount,
                    role: p.role,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** A member's role changed (owner/admin/member). */
    async memberRoleChanged(p: {
        organizationId: string;
        actorUserId?: string;
        targetUserId?: string;
        role?: string;
    }): Promise<void> {
        await this.safeCall('memberRoleChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'member_role_changed',
                {
                    organizationId: p.organizationId,
                    targetUserId: p.targetUserId,
                    role: p.role,
                },
                { organization: p.organizationId },
            );
        });
    }

    /** A CLI/API key was minted or revoked — the CLI's adoption signal. */
    async cliKeyChanged(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        created: boolean;
    }): Promise<void> {
        await this.safeCall('cliKeyChanged', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                p.created ? 'cli_key_created' : 'cli_key_revoked',
                { organizationId: p.organizationId, teamId: p.teamId },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /**
     * An organization-level setting was written. One event with the key
     * rather than a method per toggle: the keys already exist as an enum,
     * and a new setting should show up in analytics without a code change
     * here. BYOK keeps its own richer event (`byok_configured`).
     */
    async organizationSettingsUpdated(p: {
        organizationId: string;
        teamId?: string;
        actorUserId?: string;
        settingKey: string;
    }): Promise<void> {
        await this.safeCall('organizationSettingsUpdated', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'organization_settings_updated',
                {
                    organizationId: p.organizationId,
                    teamId: p.teamId,
                    settingKey: p.settingKey,
                },
                { organization: p.organizationId, team: p.teamId },
            );
        });
    }

    /** SAML SSO was configured or its connection test was run. */
    async ssoConfigured(p: {
        organizationId: string;
        actorUserId?: string;
        protocol?: string;
        active?: boolean;
        domainCount?: number;
    }): Promise<void> {
        await this.safeCall('ssoConfigured', () => {
            this.posthog.capture(
                p.actorUserId ?? p.organizationId,
                'sso_configured',
                {
                    organizationId: p.organizationId,
                    protocol: p.protocol,
                    active: p.active,
                    domainCount: p.domainCount,
                },
                { organization: p.organizationId },
            );
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
