export enum NotificationChannel {
    EMAIL = 'email',
    IN_APP = 'in_app',
    // Designed for, not built in MVP
    SLACK = 'slack',
    DISCORD = 'discord',
    WEBHOOK = 'webhook',
}

/** Channels that are implemented in MVP. */
export const ACTIVE_CHANNELS: ReadonlySet<NotificationChannel> = new Set([
    NotificationChannel.EMAIL,
    NotificationChannel.IN_APP,
]);
