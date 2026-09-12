import { APP_LINKS, rulesPageLink } from '../../../domain/catalog/app-links';
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
    [NotificationEvent.KODY_RULES_GENERATED]: (m) => {
        const rules = Array.isArray(m.rules) ? (m.rules as string[]) : [];
        return {
            title: 'Kody rules generated',
            body: rules.length
                ? `${rules.length} ${rules.length === 1 ? 'rule was' : 'rules were'} generated for ${m.organizationName ?? 'your organization'}. Review them before they start shaping reviews.`
                : `New Kody rules have been generated for ${m.organizationName ?? 'your organization'}.`,
            // Generated rules land in the organization's own rules screen,
            // not the public library the old link pointed at.
            ctaUrl: rulesPageLink(),
        };
    },
    [NotificationEvent.SSO_DOMAIN_VERIFICATION]: (m) => ({
        title: 'Verify your SSO domain',
        body: `Verify your SSO domain: ${m.domain ?? ''}`,
        ctaUrl: APP_LINKS.sso,
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
        body: `PR by ${(m.authorUsername as string) || 'unknown user'} in ${m.repoName ?? 'a repository'} was not reviewed — this user doesn't have an active license. Contact ${m.ownerContact ?? 'your admin'} to enable reviews.`,
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
            ctaUrl: rulesPageLink({
                repositoryId: m.repositoryId as string | undefined,
            }),
        };
    },

    [NotificationEvent.IDE_RULES_SYNC_FAILED]: (m) => ({
        title: 'IDE rule sync failed',
        body: `Kody could not sync rules from ${m.repoName ?? 'your repository'}: ${m.reason ?? 'unknown error'}.`,
        ctaUrl: rulesPageLink({
            repositoryId: m.repositoryId as string | undefined,
        }),
    }),

    [NotificationEvent.ORG_MEMBER_REMOVED]: (m) => {
        const removed = m.removedUser as
            { name?: string; email?: string } | undefined;
        const name = removed?.name ?? removed?.email ?? 'A member';
        return {
            title: 'Member removed',
            body: `${name} was removed from ${m.organizationName ?? 'the organization'}.`,
            ctaUrl: APP_LINKS.organizationMembers,
        };
    },

    [NotificationEvent.ORG_ROLE_CHANGED]: (m) => ({
        title: 'Member role changed',
        body: `${m.affectedUserEmail ?? 'A member'}'s role in ${m.organizationName ?? 'the organization'} changed from ${m.previousRole ?? 'unknown'} to ${m.newRole ?? 'unknown'}${m.changedBy ? ` by ${m.changedBy}` : ''}.`,
        ctaUrl: APP_LINKS.organizationMembers,
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
            days == null ? 'soon' : days === 1 ? 'tomorrow' : `in ${days} days`;
        return {
            title: 'Trial expiring',
            body: `Your trial ends ${remaining}. Upgrade to keep Kody reviewing your pull requests.`,
            ctaUrl: m.upgradeUrl as string | undefined,
        };
    },

    [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: (m) => ({
        title: 'BYOK LLM errors exceeded threshold',
        body: `Your ${m.provider ?? 'BYOK'} model returned ${m.errorCount ?? 0} errors in the recent window. Reviews may be impacted. Latest error: ${m.sampleError ?? 'n/a'}.`,
        ctaUrl: APP_LINKS.models,
    }),

    [NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED]: (m) => ({
        title: `BYOK spend at ${m.percentage ?? 0}% of your monthly limit`,
        body: `Your BYOK model spend this month is $${m.spentUsd ?? 0} of your $${m.monthlyLimitUsd ?? 0} limit (${m.percentage ?? 0}%). This is an alert only — reviews keep running. Set a hard cap with your model provider to actually stop spend.`,
        ctaUrl: APP_LINKS.tokenUsage,
    }),

    [NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL]: (m) => ({
        title: 'BYOK monthly spend limit exceeded',
        body: `Your BYOK spend ($${m.spentUsd ?? 0}) has passed your $${m.monthlyLimitUsd ?? 0} monthly limit. We won't notify you again this month. Reviews continue to run — set a hard cap with your model provider if you need to stop spend.`,
        ctaUrl: APP_LINKS.tokenUsage,
    }),

    [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: (m) => {
        const count = m.invalidCount as number | undefined;
        const repo = m.repoName ?? 'a repository';
        const issues = Array.isArray(m.issues)
            ? (m.issues as Array<{ ruleId?: string }>)
            : [];
        const repositoryId = m.repositoryId as string | undefined;
        return {
            title: 'Kody rule references are invalid',
            body:
                count != null
                    ? `${count} ${count === 1 ? 'rule has' : 'rules have'} a file reference that no longer matches in ${repo}. Affected rules are skipped during review until fixed.`
                    : `Some Kody rules in ${repo} reference files that no longer match. Affected rules are skipped during review until fixed.`,
            // One affected rule opens straight on it; several land on the
            // repository's rules list, where the drawer also lists each one.
            ctaUrl: rulesPageLink({
                repositoryId,
                ruleId: issues.length === 1 ? issues[0]?.ruleId : undefined,
            }),
        };
    },
};
