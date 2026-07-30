export interface NotificationDelivery {
    uuid: string;
    event: string;
    criticality: EventCriticality;
    title: string;
    body: string;
    ctaUrl?: string;
    category: string;
    metadata: Record<string, unknown>;
    createdAt: string;
}

export interface UserNotification {
    uuid: string;
    userId: string;
    deliveryId: string;
    readAt: string | null;
    createdAt: string;
    delivery: NotificationDelivery;
}

export interface NotificationListResponse {
    data: UserNotification[];
    total: number;
    page: number;
    limit: number;
}

export interface UnreadCountResponse {
    count: number;
}

export interface RoutingRule {
    uuid: string;
    organizationId: string;
    event: string;
    category?: string | null;
    role: string;
    channels: Record<string, boolean>;
    createdAt: string;
    updatedAt: string;
}

export interface UpsertRoutingRulePayload {
    event: string;
    role: string;
    channels: Record<string, boolean>;
    /** When true, removes this (event, role) row so it inherits from '*'. */
    delete?: boolean;
}

export type EventCriticality =
    | "system"
    | "critical"
    | "transactional"
    | "informational";

export type CatalogIcon =
    | "bell"
    | "shield-alert"
    | "zap"
    | "info"
    | "credit-card";

export interface EventCatalogEntry {
    event: string;
    label: string;
    category: string;
    criticality: EventCriticality;
    /** Channels delivered to when no routing rule exists for the event. */
    defaultChannels: Record<string, boolean>;
    /** Lucide icon name surfaced in the drawer; defaults to 'bell'. */
    icon?: CatalogIcon;
    /**
     * Critical events with this flag render a sticky non-dismissible
     * banner in the app shell. Only meaningful when criticality is 'critical'.
     */
    pageSeverity?: boolean;
    /**
     * Label for the CTA button when `delivery.ctaUrl` is present
     * (drawer + banner). Defaults to 'View' when absent.
     */
    actionLabel?: string;
    /**
     * Roles that actually receive this event (role-fanout events only). When
     * set, the settings page only offers it under those roles. Absent = any
     * role can receive it (user/email-directed or PR-author style) — shown
     * under every role.
     */
    defaultRoles?: string[];
}

/**
 * Full notification system configuration the UI consumes. Everything
 * needed to render the drawer, the banner, and the settings page lives
 * here — there are no hardcoded channel/role/criticality/category
 * lists on the frontend.
 */
export interface NotificationConfig {
    events: EventCatalogEntry[];
    channels: Array<{ value: string; label: string }>;
    criticalities: Array<{ value: EventCriticality; label: string }>;
    categories: Array<{ value: string; label: string }>;
    roles: Array<{ value: string; label: string }>;
}
