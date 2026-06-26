import { NotificationEvent } from '../../../domain/catalog/events';

/**
 * What the in-app channel needs at delivery time. Both fields are
 * mandatory; `ctaUrl` is optional and falls back to the payload's
 * top-level `ctaUrl` (set by the dispatcher) when absent.
 */
export interface ResolvedInAppTemplate {
    title: string;
    body: string;
    ctaUrl?: string;
}

export type InAppTemplateBuilder = (
    metadata: Record<string, unknown>,
) => ResolvedInAppTemplate;

/**
 * Per-event in-app template registry. Mirrors EMAIL_TEMPLATE_REGISTRY:
 * adding a new in-app notification = adding an entry here, no channel
 * adapter changes.
 *
 * Builders are pure — they consume the message payload and return the
 * title/body the dispatcher persists on the `notification_deliveries`
 * row and renders in the bell drawer.
 */
export const IN_APP_TEMPLATE_REGISTRY: Partial<
    Record<NotificationEvent, InAppTemplateBuilder>
> = {
    // Existing events keep their previous body strings so behaviour
    // doesn't change for the 6 catalog entries already in production.
    [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: (m) => ({
        title: 'Confirm your email',
        body: `Confirm your email for ${m.organizationName ?? 'your organization'}.`,
    }),
    [NotificationEvent.AUTH_FORGOT_PASSWORD]: () => ({
        title: 'Password reset',
        body: 'A password reset was requested for your account.',
    }),
    [NotificationEvent.TEAM_MEMBER_INVITED]: () => ({
        title: 'Team invitation',
        body: `You've been invited to join a team.`,
    }),
    [NotificationEvent.KODY_RULES_GENERATED]: (m) => ({
        title: 'Kody rules generated',
        body: `New Kody rules have been generated for ${m.organizationName ?? 'your organization'}.`,
    }),
    [NotificationEvent.SSO_DOMAIN_VERIFICATION]: (m) => ({
        title: 'Verify your SSO domain',
        body: `Verify your SSO domain: ${m.domain ?? ''}`,
    }),
    [NotificationEvent.ORG_REPORT]: () => ({
        title: 'Your Kodus report is ready',
        body: 'Your organization review report is ready.',
    }),
    [NotificationEvent.REPO_REPORT]: () => ({
        title: 'Your Kodus repo digest is ready',
        body: 'Your per-repo review digest is ready.',
    }),

    // ── New events (this PR) ───────────────────────────────────

    [NotificationEvent.REVIEW_AUTO_APPROVED]: (m) => ({
        title: 'Pull request auto-approved',
        body: `${m.repoName ?? 'A pull request'} was auto-approved by Kody.`,
        ctaUrl: m.prUrl as string | undefined,
    }),

    [NotificationEvent.REVIEW_FAILED]: (m) => ({
        title: 'Code review failed',
        body: `Kody could not review ${m.repoName ?? 'a pull request'}: ${m.reason ?? 'unknown error'}.`,
        ctaUrl: m.prUrl as string | undefined,
    }),

    [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: (m) => ({
        title: 'Review skipped — license required',
        body: `${m.repoName ?? 'A pull request'} was not reviewed because your organization lacks an active license. Contact ${m.ownerContact ?? 'your admin'} to enable reviews.`,
        ctaUrl: m.prUrl as string | undefined,
    }),

    [NotificationEvent.IDE_RULES_SYNCED]: (m) => {
        const count = m.rulesCount as number | undefined;
        const repo = m.repoName ?? 'your repository';
        return {
            title: 'IDE rules synced',
            body:
                count != null
                    ? `${count} ${count === 1 ? 'rule' : 'rules'} synced from ${repo}.`
                    : `Rules synced from ${repo}.`,
        };
    },

    [NotificationEvent.IDE_RULES_SYNC_FAILED]: (m) => ({
        title: 'IDE rule sync failed',
        body: `Kody could not sync rules from ${m.repoName ?? 'your repository'}: ${m.reason ?? 'unknown error'}.`,
    }),

    [NotificationEvent.ORG_MEMBER_REMOVED]: (m) => {
        const removed = m.removedUser as
            | { name?: string; email?: string }
            | undefined;
        const name = removed?.name ?? removed?.email ?? 'A member';
        return {
            title: 'Member removed',
            body: `${name} was removed from ${m.organizationName ?? 'the organization'}.`,
        };
    },

    [NotificationEvent.ORG_ROLE_CHANGED]: (m) => ({
        title: 'Member role changed',
        body: `${m.affectedUserEmail ?? 'A member'}'s role in ${m.organizationName ?? 'the organization'} changed from ${m.previousRole ?? 'unknown'} to ${m.newRole ?? 'unknown'}${m.changedBy ? ` by ${m.changedBy}` : ''}.`,
    }),

    [NotificationEvent.BILLING_PAYMENT_FAILED]: (m) => {
        const amount = m.amount as number | undefined;
        const currency = (m.currency as string | undefined) ?? '';
        const formatted =
            amount != null
                ? `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`
                : 'your subscription';
        return {
            title: 'Payment failed',
            body: `Your payment of ${formatted} could not be processed: ${m.failureReason ?? 'unknown error'}. Update your payment method to keep your subscription active.`,
            ctaUrl: m.updatePaymentUrl as string | undefined,
        };
    },

    [NotificationEvent.BILLING_TRIAL_EXPIRING]: (m) => {
        const days = m.daysRemaining as number | undefined;
        const remaining =
            days == null
                ? 'soon'
                : days === 1
                  ? 'tomorrow'
                  : `in ${days} days`;
        return {
            title: 'Trial expiring',
            body: `Your trial ends ${remaining}. Upgrade to keep Kody reviewing your pull requests.`,
            ctaUrl: m.upgradeUrl as string | undefined,
        };
    },

    [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: (m) => ({
        title: 'BYOK LLM errors exceeded threshold',
        body: `Your ${m.provider ?? 'BYOK'} model returned ${m.errorCount ?? 0} errors in the recent window. Reviews may be impacted. Latest error: ${m.sampleError ?? 'n/a'}.`,
    }),

    [NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED]: (m) => ({
        title: `BYOK spend at ${m.percentage ?? 0}% of your monthly limit`,
        body: `Your BYOK model spend this month is $${m.spentUsd ?? 0} of your $${m.monthlyLimitUsd ?? 0} limit (${m.percentage ?? 0}%). This is an alert only — reviews keep running. Set a hard cap with your model provider to actually stop spend.`,
    }),

    [NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL]: (m) => ({
        title: 'BYOK monthly spend limit exceeded',
        body: `Your BYOK spend ($${m.spentUsd ?? 0}) has passed your $${m.monthlyLimitUsd ?? 0} monthly limit. We won't notify you again this month. Reviews continue to run — set a hard cap with your model provider if you need to stop spend.`,
    }),

    [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: (m) => {
        const count = m.invalidCount as number | undefined;
        const repo = m.repoName ?? 'a repository';
        return {
            title: 'Kody rule references are invalid',
            body:
                count != null
                    ? `${count} ${count === 1 ? 'rule has' : 'rules have'} a file reference that no longer matches in ${repo}. Affected rules are skipped during review until fixed.`
                    : `Some Kody rules in ${repo} reference files that no longer match. Affected rules are skipped during review until fixed.`,
        };
    },
};
