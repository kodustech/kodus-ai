/**
 * Typed notification event catalog.
 *
 * Adding a new event:
 * 1. Add the enum member below.
 * 2. Add its payload type to `NotificationPayloadMap`.
 * 3. Add its defaults to `defaults.ts`.
 * Done — compile errors guide you if the payload is wrong at the call-site.
 */
export enum NotificationEvent {
    // ── Auth ────────────────────────────────────────────────────
    AUTH_EMAIL_CONFIRMATION = 'auth.email_confirmation',
    AUTH_FORGOT_PASSWORD = 'auth.forgot_password',

    // ── Organization / Team ────────────────────────────────────
    TEAM_MEMBER_INVITED = 'team.member_invited',
    ORG_MEMBER_REMOVED = 'org.member_removed',
    ORG_ROLE_CHANGED = 'org.role_changed',

    // ── Kody Rules ─────────────────────────────────────────────
    KODY_RULES_GENERATED = 'kody_rules.generated',

    // ── IDE rule sync ──────────────────────────────────────────
    IDE_RULES_SYNCED = 'ide.rules_synced',
    IDE_RULES_SYNC_FAILED = 'ide.rules_sync_failed',

    // ── Code review ────────────────────────────────────────────
    REVIEW_AUTO_APPROVED = 'review.auto_approved',
    REVIEW_FAILED = 'review.failed',
    REVIEW_SKIPPED_NO_LICENSE = 'review.skipped_no_license',

    // ── SSO ────────────────────────────────────────────────────
    SSO_DOMAIN_VERIFICATION = 'sso.domain_verification',

    // ── Cockpit reports ────────────────────────────────────────
    REPO_REPORT = 'cockpit.repo_report',
    ORG_REPORT = 'cockpit.org_report',

    // ── Billing ────────────────────────────────────────────────
    BILLING_PAYMENT_FAILED = 'billing.payment_failed',
    BILLING_TRIAL_EXPIRING = 'billing.trial_expiring',

    // ── BYOK ───────────────────────────────────────────────────
    BYOK_LLM_ERRORS_THRESHOLD = 'byok.llm_errors_threshold',

    // ── Spend limit ────────────────────────────────────────────
    SPEND_LIMIT_THRESHOLD_REACHED = 'spend_limit.threshold_reached',
    SPEND_LIMIT_EXCEEDED_FINAL = 'spend_limit.exceeded_final',

    // ── Kody Rules (continued) ─────────────────────────────────
    RULE_FILE_REFERENCES_INVALID = 'rule.file_references_invalid',

    // ── Security (future — critical) ───────────────────────────
    // SECURITY_API_KEY_LEAKED = 'security.api_key_leaked',
}

// ────────────────────────────────────────────────────────────────
// Payload map — one entry per event.
// The emitter generic `emit<E>()` infers the payload type at
// compile time, so a wrong payload is a build error.
// ────────────────────────────────────────────────────────────────

export interface NotificationPayloadMap {
    [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: {
        token: string;
        email: string;
        organizationName: string;
        organizationAndTeamData?: {
            organizationId?: string;
            teamId?: string;
        };
    };

    [NotificationEvent.AUTH_FORGOT_PASSWORD]: {
        email: string;
        name: string;
        token: string;
    };

    [NotificationEvent.TEAM_MEMBER_INVITED]: {
        /** Full user object (with teamMember, organization relations). */
        user: any;
        inviterEmail: string;
        inviteLink: string;
    };

    [NotificationEvent.KODY_RULES_GENERATED]: {
        /** All active users in the org receive the notification. */
        users: Array<{ email: string; name: string }>;
        rules: string[];
        organizationName: string;
    };

    [NotificationEvent.SSO_DOMAIN_VERIFICATION]: {
        token: string;
        email: string;
        organizationName: string;
        domain: string;
    };

    [NotificationEvent.REPO_REPORT]: {
        recipient: { email: string; name: string };
        props: Record<string, unknown>;
    };

    [NotificationEvent.ORG_REPORT]: {
        recipient: { email: string; name: string };
        props: Record<string, unknown>;
    };

    // ── Organization / Team ────────────────────────────────────

    [NotificationEvent.ORG_MEMBER_REMOVED]: {
        removedUser: { name?: string; email?: string };
        removedBy: string;
        removedAt: string;
        organizationName: string;
    };

    [NotificationEvent.ORG_ROLE_CHANGED]: {
        /** The member whose role changed (this notifies admins, not them). */
        affectedUserEmail: string;
        previousRole: string;
        newRole: string;
        changedBy: string;
        organizationName: string;
    };

    // ── IDE rule sync ──────────────────────────────────────────

    [NotificationEvent.IDE_RULES_SYNCED]: {
        repoName: string;
        rulesCount: number;
        syncMode: 'fast' | 'full' | 'changed-files';
    };

    [NotificationEvent.IDE_RULES_SYNC_FAILED]: {
        repoName: string;
        reason: string;
        correlationId: string;
    };

    // ── Code review ────────────────────────────────────────────

    [NotificationEvent.REVIEW_AUTO_APPROVED]: {
        prUrl: string;
        repoName: string;
        approvedAt: string;
    };

    [NotificationEvent.REVIEW_FAILED]: {
        prUrl: string;
        repoName: string;
        reason: string;
        correlationId: string;
    };

    [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: {
        prUrl: string;
        repoName: string;
        ownerContact?: string;
        authorUsername?: string;
    };

    // ── Billing ────────────────────────────────────────────────

    [NotificationEvent.BILLING_PAYMENT_FAILED]: {
        amount: number;
        currency: string;
        failureReason: string;
        nextRetryAt?: string;
        updatePaymentUrl?: string;
    };

    [NotificationEvent.BILLING_TRIAL_EXPIRING]: {
        trialEndsAt: string;
        daysRemaining: number;
        upgradeUrl?: string;
    };

    // ── BYOK ───────────────────────────────────────────────────

    [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: {
        provider: string;
        errorCount: number;
        windowStart: string;
        windowEnd: string;
        sampleError: string;
    };

    // ── Spend limit ────────────────────────────────────────────

    [NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED]: {
        /** Threshold crossed: 50, 75, 90, or 100. */
        percentage: number;
        monthlyLimitUsd: number;
        spentUsd: number;
        /** Calendar month the spend covers — YYYY-MM in UTC. */
        periodKey: string;
    };

    [NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL]: {
        monthlyLimitUsd: number;
        spentUsd: number;
        periodKey: string;
    };

    // ── Kody Rules (file reference validation) ────────────────

    [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: {
        source: 'ide' | 'manual' | 'auto_recheck';
        repoName: string;
        invalidCount: number;
        issues: Array<{
            ruleId: string;
            ruleName: string;
            filePath: string;
            reason: string;
        }>;
    };
}
