import * as React from 'react';

import { EmailFrom } from '@libs/common/email/from';
import ByokErrorsThresholdEmail, {
    byokErrorsThresholdEmailMeta,
} from '@libs/common/email/templates/byok-errors-threshold';
import SpendLimitThresholdEmail, {
    spendLimitThresholdEmailMeta,
} from '@libs/common/email/templates/spend-limit-threshold';
import SpendLimitExceededEmail, {
    spendLimitExceededEmailMeta,
} from '@libs/common/email/templates/spend-limit-exceeded';
import ConfirmationEmail, {
    confirmationEmailMeta,
} from '@libs/common/email/templates/confirmation';
import DomainVerificationEmail, {
    domainVerificationEmailMeta,
} from '@libs/common/email/templates/domain-verification';
import ForgotPasswordEmail, {
    forgotPasswordEmailMeta,
} from '@libs/common/email/templates/forgot-password';
import IdeRulesSyncFailedEmail, {
    ideRulesSyncFailedEmailMeta,
} from '@libs/common/email/templates/ide-rules-sync-failed';
import InviteEmail, {
    inviteEmailMeta,
} from '@libs/common/email/templates/invite';
import KodyRulesEmail, {
    kodyRulesEmailMeta,
} from '@libs/common/email/templates/kody-rules';
import MemberRemovedEmail, {
    memberRemovedEmailMeta,
} from '@libs/common/email/templates/member-removed';
import PaymentFailedEmail, {
    paymentFailedEmailMeta,
} from '@libs/common/email/templates/payment-failed';
import ReviewFailedEmail, {
    reviewFailedEmailMeta,
} from '@libs/common/email/templates/review-failed';
import RuleFileReferencesInvalidEmail, {
    ruleFileReferencesInvalidEmailMeta,
} from '@libs/common/email/templates/rule-file-references-invalid';
import TrialExpiringEmail, {
    trialExpiringEmailMeta,
} from '@libs/common/email/templates/trial-expiring';
import RepoReportEmail, {
    repoReportEmailMeta,
} from '@libs/common/email/templates/repo-report';
import OrgReportEmail, {
    orgReportEmailMeta,
} from '@libs/common/email/templates/org-report';
import IdeRulesSyncedEmail, {
    ideRulesSyncedEmailMeta,
} from '@libs/common/email/templates/ide-rules-synced';
import OrgRoleChangedEmail, {
    orgRoleChangedEmailMeta,
} from '@libs/common/email/templates/org-role-changed';
import ReviewAutoApprovedEmail, {
    reviewAutoApprovedEmailMeta,
} from '@libs/common/email/templates/review-auto-approved';
import ReviewSkippedNoLicenseEmail, {
    reviewSkippedNoLicenseEmailMeta,
} from '@libs/common/email/templates/review-skipped-no-license';

import { NotificationEvent } from '../../../domain/catalog/events';

export interface ResolvedEmailTemplate {
    from: EmailFrom;
    subject: string;
    react: React.ReactElement;
    replyTo?: string;
}

/**
 * Context passed to every template builder. Pulled from runtime config
 * by the adapter so builders stay synchronous and dependency-free.
 */
export interface EmailTemplateContext {
    /** Public web URL used to build links inside the email body. */
    webUrl: string;
}

/**
 * Signature every entry in the registry implements. The metadata
 * argument is the notification payload as carried through the
 * dispatcher — typed loosely here so the registry can stay simple;
 * builders cast to the specific shape they expect.
 */
export type EmailTemplateBuilder = (
    metadata: Record<string, unknown>,
    ctx: EmailTemplateContext,
) => ResolvedEmailTemplate;

/**
 * Maps every email-bearing notification event to its template builder.
 *
 * Adding a new email notification:
 *   1. Add the event to NotificationEvent + NotificationPayloadMap.
 *   2. Add an EVENT_DEFAULTS entry.
 *   3. Add the React Email template under `@libs/common/email/templates`.
 *   4. Register the builder here. No changes to the channel adapter.
 */
export const EMAIL_TEMPLATE_REGISTRY: Partial<
    Record<NotificationEvent, EmailTemplateBuilder>
> = {
    [NotificationEvent.AUTH_FORGOT_PASSWORD]: (metadata, { webUrl }) => {
        const token = metadata.token as string;
        return {
            ...forgotPasswordEmailMeta,
            react: ForgotPasswordEmail({
                resetLink: `${webUrl}/forgot-password/reset?token=${token}`,
            }),
        };
    },

    [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: (metadata, { webUrl }) => {
        const token = metadata.token as string;
        const organizationName = metadata.organizationName as string;
        return {
            ...confirmationEmailMeta,
            react: ConfirmationEmail({
                organizationName,
                confirmLink: `${webUrl}/confirm-email?token=${token}`,
            }),
        };
    },

    [NotificationEvent.TEAM_MEMBER_INVITED]: (metadata) => {
        const user = metadata.user as any;
        const inviterEmail = metadata.inviterEmail as string;
        const inviteLink = metadata.inviteLink as string;
        const inviteeName =
            user?.teamMember?.[0]?.name ?? user?.email?.split('@')[0] ?? '';
        const organizationName = user?.organization?.name ?? '';
        const teamName = user?.teamMember?.[0]?.team?.name ?? organizationName;
        return {
            ...inviteEmailMeta({ teamName }),
            react: InviteEmail({
                inviteeName,
                inviterEmail,
                organizationName,
                teamName,
                inviteLink,
            }),
        };
    },

    [NotificationEvent.KODY_RULES_GENERATED]: (metadata, { webUrl }) => {
        const rules = metadata.rules as string[];
        const organizationName = metadata.organizationName as string;
        const userName = (metadata as { userName?: string }).userName ?? '';
        return {
            ...kodyRulesEmailMeta({ organizationName }),
            react: KodyRulesEmail({
                userName,
                organizationName,
                rules,
                rulesCount: rules.length,
                rulesLink: `${webUrl}/settings/code-review/global/kody-rules`,
            }),
        };
    },

    [NotificationEvent.SSO_DOMAIN_VERIFICATION]: (metadata, { webUrl }) => {
        const token = metadata.token as string;
        const domain = metadata.domain as string;
        const organizationName = metadata.organizationName as string;
        return {
            ...domainVerificationEmailMeta({ domain }),
            react: DomainVerificationEmail({
                organizationName,
                domain,
                confirmLink: `${webUrl}/api/sso/domain-verification/confirm?token=${token}`,
            }),
        };
    },

    [NotificationEvent.REPO_REPORT]: (metadata) => {
        const props = metadata.props as Record<string, unknown>;
        const sections = (props.sections as Array<{ repository?: string }>) ?? [];
        return {
            ...repoReportEmailMeta({
                repoCount: sections.length,
                repoName: sections[0]?.repository,
                startDate: (props.startDate as string) ?? '',
                endDate: (props.endDate as string) ?? '',
            }),
            react: RepoReportEmail(props as any),
        };
    },

    [NotificationEvent.ORG_REPORT]: (metadata) => {
        const props = metadata.props as Record<string, unknown>;
        return {
            ...orgReportEmailMeta({
                company: (props.company as string) ?? '',
                startDate: (props.startDate as string) ?? '',
            }),
            react: OrgReportEmail(props as any),
        };
    },

    [NotificationEvent.ORG_MEMBER_REMOVED]: (metadata) => {
        const removed =
            (metadata.removedUser as
                | { name?: string; email?: string }
                | undefined) ?? {};
        const removedUserName = removed.name ?? removed.email ?? 'there';
        const organizationName = metadata.organizationName as string;
        const removedBy = metadata.removedBy as string;
        return {
            ...memberRemovedEmailMeta({ organizationName }),
            react: MemberRemovedEmail({
                removedUserName,
                organizationName,
                removedBy,
            }),
        };
    },

    [NotificationEvent.REVIEW_FAILED]: (metadata) => {
        const prUrl = metadata.prUrl as string;
        const repoName = metadata.repoName as string;
        const reason = metadata.reason as string;
        const correlationId = metadata.correlationId as string;
        return {
            ...reviewFailedEmailMeta({ repoName }),
            react: ReviewFailedEmail({
                prUrl,
                repoName,
                reason,
                correlationId,
            }),
        };
    },

    [NotificationEvent.REVIEW_AUTO_APPROVED]: (metadata) => {
        const prUrl = metadata.prUrl as string;
        const repoName = metadata.repoName as string;
        return {
            ...reviewAutoApprovedEmailMeta({ repoName }),
            react: ReviewAutoApprovedEmail({ prUrl, repoName }),
        };
    },

    [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: (metadata) => {
        const prUrl = metadata.prUrl as string;
        const repoName = metadata.repoName as string;
        const ownerContact = metadata.ownerContact as string | undefined;
        const authorUsername = metadata.authorUsername as string | undefined;
        return {
            ...reviewSkippedNoLicenseEmailMeta({ repoName }),
            react: ReviewSkippedNoLicenseEmail({
                prUrl,
                repoName,
                ownerContact,
                authorUsername,
            }),
        };
    },

    [NotificationEvent.IDE_RULES_SYNCED]: (metadata, { webUrl }) => {
        const repoName = metadata.repoName as string;
        const rulesCount = (metadata.rulesCount as number | undefined) ?? 0;
        return {
            ...ideRulesSyncedEmailMeta({ repoName }),
            react: IdeRulesSyncedEmail({
                repoName,
                rulesCount,
                rulesLink: `${webUrl}/settings/code-review/global/kody-rules`,
            }),
        };
    },

    [NotificationEvent.ORG_ROLE_CHANGED]: (metadata) => {
        const affectedUserEmail = metadata.affectedUserEmail as string;
        const previousRole = metadata.previousRole as string;
        const newRole = metadata.newRole as string;
        const organizationName = metadata.organizationName as string;
        const changedBy = metadata.changedBy as string | undefined;
        return {
            ...orgRoleChangedEmailMeta({ affectedUserEmail, organizationName }),
            react: OrgRoleChangedEmail({
                affectedUserEmail,
                previousRole,
                newRole,
                organizationName,
                changedBy,
            }),
        };
    },

    [NotificationEvent.IDE_RULES_SYNC_FAILED]: (metadata) => {
        const repoName = metadata.repoName as string;
        const reason = metadata.reason as string;
        const correlationId = metadata.correlationId as string;
        return {
            ...ideRulesSyncFailedEmailMeta({ repoName }),
            react: IdeRulesSyncFailedEmail({
                repoName,
                reason,
                correlationId,
            }),
        };
    },

    [NotificationEvent.BILLING_PAYMENT_FAILED]: (metadata) => {
        const amount = (metadata.amount as number | undefined) ?? 0;
        const currency =
            (metadata.currency as string | undefined)?.toUpperCase() ?? '';
        const failureReason =
            (metadata.failureReason as string) ?? 'Unknown error';
        const nextRetryAt = metadata.nextRetryAt as string | undefined;
        const updatePaymentUrl = metadata.updatePaymentUrl as
            | string
            | undefined;
        const formattedAmount = currency
            ? `${currency} ${(amount / 100).toFixed(2)}`
            : `${(amount / 100).toFixed(2)}`;
        const nextRetryAtLabel = nextRetryAt
            ? new Date(nextRetryAt).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
              })
            : undefined;
        return {
            ...paymentFailedEmailMeta,
            react: PaymentFailedEmail({
                formattedAmount,
                failureReason,
                nextRetryAtLabel,
                updatePaymentUrl,
            }),
        };
    },

    [NotificationEvent.BILLING_TRIAL_EXPIRING]: (metadata) => {
        const daysRemaining =
            (metadata.daysRemaining as number | undefined) ?? 0;
        const trialEndsAt = metadata.trialEndsAt as string | undefined;
        const upgradeUrl = metadata.upgradeUrl as string | undefined;
        const trialEndsAtLabel = trialEndsAt
            ? new Date(trialEndsAt).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
              })
            : 'soon';
        return {
            ...trialExpiringEmailMeta({ daysRemaining }),
            react: TrialExpiringEmail({
                daysRemaining,
                trialEndsAtLabel,
                upgradeUrl,
            }),
        };
    },

    [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: (metadata) => {
        const provider = (metadata.provider as string) ?? 'BYOK';
        const errorCount = (metadata.errorCount as number | undefined) ?? 0;
        const windowStart = metadata.windowStart as string | undefined;
        const windowEnd = metadata.windowEnd as string | undefined;
        const sampleError =
            (metadata.sampleError as string) ?? 'see logs for details';
        const labelFormat = (iso?: string) =>
            iso
                ? new Date(iso).toLocaleString('en-US', {
                      timeZone: 'UTC',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                  }) + ' UTC'
                : 'n/a';
        return {
            ...byokErrorsThresholdEmailMeta({ provider }),
            react: ByokErrorsThresholdEmail({
                provider,
                errorCount,
                windowStartLabel: labelFormat(windowStart),
                windowEndLabel: labelFormat(windowEnd),
                sampleError,
            }),
        };
    },

    [NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED]: (metadata) => {
        const percentage = (metadata.percentage as number) ?? 0;
        const usd = (value: unknown) => {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : '$0';
        };
        return {
            ...spendLimitThresholdEmailMeta({ percentage }),
            react: SpendLimitThresholdEmail({
                percentage,
                limitLabel: usd(metadata.monthlyLimitUsd),
                spentLabel: usd(metadata.spentUsd),
            }),
        };
    },

    [NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL]: (metadata) => {
        const usd = (value: unknown) => {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : '$0';
        };
        return {
            ...spendLimitExceededEmailMeta(),
            react: SpendLimitExceededEmail({
                limitLabel: usd(metadata.monthlyLimitUsd),
                spentLabel: usd(metadata.spentUsd),
            }),
        };
    },

    [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: (metadata) => {
        const repoName = (metadata.repoName as string) ?? '';
        const issues =
            (metadata.issues as Array<{
                ruleId: string;
                ruleName: string;
                filePath: string;
                reason: string;
            }>) ?? [];
        const invalidCount =
            (metadata.invalidCount as number | undefined) ?? issues.length;
        return {
            ...ruleFileReferencesInvalidEmailMeta({ repoName, invalidCount }),
            react: RuleFileReferencesInvalidEmail({
                repoName,
                invalidCount,
                issues: issues.map(({ ruleName, filePath, reason }) => ({
                    ruleName,
                    filePath,
                    reason,
                })),
            }),
        };
    },
};
