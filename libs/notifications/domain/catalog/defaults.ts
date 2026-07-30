import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { Criticality, NotificationChannel } from '../enums';
import { NotificationEvent } from './events';

/**
 * Identifier of a lucide-react icon. Resolved to a component by the
 * frontend; kept here as a string so the catalog can ship over the wire
 * without React on the API side.
 */
export type CatalogIcon =
    | 'bell'
    | 'shield-alert'
    | 'zap'
    | 'info'
    | 'credit-card';

/**
 * Static metadata for each event in the catalog.
 * This is the source of truth for criticality, category, and the
 * default channels that are enabled when an org is first set up.
 */
export interface EventDefaults {
    readonly criticality: Criticality;
    readonly category: string;
    /** Human-readable label for the admin UI. */
    readonly label: string;
    /** Channels enabled by default when seeding routing rules. */
    readonly defaultChannels: ReadonlySet<NotificationChannel>;
    /**
     * Icon hint surfaced by the in-app drawer. Defaults to 'bell' when
     * absent so adding a new event without an icon still renders.
     */
    readonly icon?: CatalogIcon;
    /**
     * Page-severity flag for the most severe CRITICAL events. The
     * in-app shell renders a sticky non-dismissible banner for unread
     * notifications whose event has this set. Only meaningful when
     * `criticality === CRITICAL`.
     */
    readonly pageSeverity?: boolean;
    /**
     * Label rendered on the in-app banner / drawer CTA button when
     * `ctaUrl` is present. Defaults to 'View' on the frontend when not
     * declared — set explicitly for actionable critical events.
     */
    readonly actionLabel?: string;
    /**
     * The role(s) this event is actually delivered to, for events that fan
     * out purely by role (their emitter uses `kind: 'role'` recipients).
     * Drives the settings UI so it only offers per-role routing for roles
     * that can receive the event. Omit for events directed at a specific
     * user/email, or whose audience can be any role (e.g. a PR author) — the
     * UI shows all roles for those.
     */
    readonly defaultRoles?: readonly Role[];
}

export const EVENT_DEFAULTS: Readonly<
    Record<NotificationEvent, EventDefaults>
> = {
    [NotificationEvent.AUTH_EMAIL_CONFIRMATION]: {
        criticality: Criticality.SYSTEM,
        category: 'auth',
        label: 'Email Confirmation',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'shield-alert',
    },
    [NotificationEvent.AUTH_FORGOT_PASSWORD]: {
        criticality: Criticality.SYSTEM,
        category: 'auth',
        label: 'Forgot Password',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'shield-alert',
    },
    [NotificationEvent.TEAM_MEMBER_INVITED]: {
        criticality: Criticality.SYSTEM,
        category: 'team',
        label: 'Team Invite',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'zap',
    },
    [NotificationEvent.KODY_RULES_GENERATED]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'kody_rules',
        label: 'Kody Rules Generated',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'bell',
    },
    [NotificationEvent.SSO_DOMAIN_VERIFICATION]: {
        criticality: Criticality.SYSTEM,
        category: 'sso',
        label: 'SSO Domain Verification',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'shield-alert',
    },
    [NotificationEvent.REPO_REPORT]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'cockpit',
        label: 'Repo Report',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'info',
    },
    [NotificationEvent.ORG_REPORT]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'cockpit',
        label: 'Org Report',
        defaultChannels: new Set([NotificationChannel.EMAIL]),
        icon: 'info',
    },

    // ── Organization / Team ────────────────────────────────────

    [NotificationEvent.ORG_MEMBER_REMOVED]: {
        criticality: Criticality.TRANSACTIONAL,
        category: 'team',
        label: 'Member Removed',
        // Default channels cover both audiences; per-recipient channel
        // overrides (set by the call site) restrict the removed user to
        // email and the surviving owners to in-app.
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'zap',
    },
    [NotificationEvent.ORG_ROLE_CHANGED]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'team',
        label: 'Role Changed',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'zap',
        // Pure role-fanout: the audience is the org owners, derived from
        // config rather than hardcoded at the call site.
        defaultRoles: [Role.OWNER],
    },

    // ── IDE rule sync ──────────────────────────────────────────

    [NotificationEvent.IDE_RULES_SYNCED]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'kody_rules',
        label: 'IDE Rules Synced',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'bell',
    },
    [NotificationEvent.IDE_RULES_SYNC_FAILED]: {
        criticality: Criticality.TRANSACTIONAL,
        category: 'kody_rules',
        label: 'IDE Rule Sync Failed',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'shield-alert',
        // Mixed event: the sync initiator is notified directly (emit
        // recipient); the owner audience is config-driven.
        defaultRoles: [Role.OWNER],
    },

    // ── Code review ────────────────────────────────────────────

    [NotificationEvent.REVIEW_AUTO_APPROVED]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'review',
        label: 'Pull Request Auto-Approved',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'bell',
    },
    [NotificationEvent.REVIEW_FAILED]: {
        criticality: Criticality.TRANSACTIONAL,
        category: 'review',
        label: 'Code Review Failed',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'shield-alert',
        // Mixed event: the PR author is notified directly (emit recipient);
        // the owner audience is config-driven.
        defaultRoles: [Role.OWNER],
    },
    [NotificationEvent.REVIEW_SKIPPED_NO_LICENSE]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'review',
        label: 'Review Skipped (No License)',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'info',
    },

    // ── Billing ────────────────────────────────────────────────

    [NotificationEvent.BILLING_PAYMENT_FAILED]: {
        criticality: Criticality.CRITICAL,
        category: 'billing',
        label: 'Payment Failed',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'credit-card',
        pageSeverity: true,
        actionLabel: 'Update payment',
        defaultRoles: [Role.OWNER, Role.BILLING_MANAGER],
    },
    [NotificationEvent.BILLING_TRIAL_EXPIRING]: {
        criticality: Criticality.TRANSACTIONAL,
        category: 'billing',
        label: 'Trial Expiring',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'credit-card',
        actionLabel: 'Upgrade plan',
        defaultRoles: [Role.OWNER, Role.BILLING_MANAGER],
    },

    // ── BYOK ───────────────────────────────────────────────────

    [NotificationEvent.BYOK_LLM_ERRORS_THRESHOLD]: {
        criticality: Criticality.CRITICAL,
        category: 'byok',
        label: 'BYOK LLM Errors Exceeded Threshold',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'shield-alert',
        pageSeverity: true,
        defaultRoles: [Role.OWNER],
    },

    // ── Spend limit ────────────────────────────────────────────

    [NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED]: {
        criticality: Criticality.INFORMATIONAL,
        category: 'spend_limit',
        label: 'Monthly Spend Limit Threshold Reached',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'credit-card',
        defaultRoles: [Role.OWNER],
    },

    [NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL]: {
        criticality: Criticality.CRITICAL,
        category: 'spend_limit',
        label: 'Monthly Spend Limit Exceeded',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'credit-card',
        pageSeverity: true,
        defaultRoles: [Role.OWNER],
    },

    // ── Kody Rules (file reference validation) ────────────────

    [NotificationEvent.RULE_FILE_REFERENCES_INVALID]: {
        criticality: Criticality.TRANSACTIONAL,
        category: 'kody_rules',
        label: 'Rule File References Invalid',
        defaultChannels: new Set([
            NotificationChannel.EMAIL,
            NotificationChannel.IN_APP,
        ]),
        icon: 'shield-alert',
    },
};

/** All event categories, derived from the catalog. */
export const EVENT_CATEGORIES = [
    ...new Set(Object.values(EVENT_DEFAULTS).map((d) => d.category)),
] as const;

/**
 * Display labels for the four notification system axes that the
 * settings UI renders: channels, criticalities, categories, and roles.
 *
 * Centralized here so the frontend pulls them with the catalog response
 * — adding a new notification only ever requires backend changes.
 */
export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
    [NotificationChannel.EMAIL]: 'Email',
    [NotificationChannel.IN_APP]: 'In-App',
    [NotificationChannel.SLACK]: 'Slack',
    [NotificationChannel.DISCORD]: 'Discord',
    [NotificationChannel.WEBHOOK]: 'Webhook',
};

export const CRITICALITY_LABELS: Record<Criticality, string> = {
    [Criticality.SYSTEM]: 'System',
    [Criticality.CRITICAL]: 'Critical',
    [Criticality.TRANSACTIONAL]: 'Transactional',
    [Criticality.INFORMATIONAL]: 'Informational',
};

export const CATEGORY_LABELS: Record<string, string> = {
    auth: 'Auth',
    team: 'Team',
    kody_rules: 'Kody Rules',
    sso: 'SSO',
    cockpit: 'Cockpit',
    billing: 'Billing',
    review: 'Code Review',
    byok: 'BYOK',
    spend_limit: 'Spend Limit',
};

/**
 * Wildcard role used by the routing rules to express the "All Roles"
 * default config. Kept as a string here so the constant is shareable
 * with the catalog response — the Role enum has no wildcard member.
 */
export const ROLE_WILDCARD = '*';

export const ROLE_LABELS: Record<string, string> = {
    [ROLE_WILDCARD]: 'All Roles',
    [Role.OWNER]: 'Owner',
    [Role.BILLING_MANAGER]: 'Billing Manager',
    [Role.REPO_ADMIN]: 'Repo Admin',
    [Role.CONTRIBUTOR]: 'Contributor',
};
