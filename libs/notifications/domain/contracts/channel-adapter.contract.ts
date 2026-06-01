import { NotificationChannel, Criticality } from '../enums';
import { NotificationEvent } from '../catalog/events';

/**
 * Context passed to every channel adapter for delivery.
 */
export interface NotificationDeliveryContext {
    /** The delivery row ID (already persisted in notification_deliveries). */
    deliveryId: string;
    userId: string;
    userEmail: string;
    userRole: string;
    organizationId: string;
    event: NotificationEvent;
    criticality: Criticality;
    title: string;
    body: string;
    ctaUrl?: string;
    category: string;
    metadata: Record<string, unknown>;
    correlationId: string;
}

/**
 * Each channel adapter implements this interface.
 * The dispatcher calls `deliver()` for every resolved channel.
 */
export interface IChannelAdapter {
    readonly channel: NotificationChannel;

    deliver(context: NotificationDeliveryContext): Promise<void>;
}

/**
 * Injection token used to collect all channel adapters.
 * The notification module registers each adapter under this multi-provider token.
 */
export const CHANNEL_ADAPTERS_TOKEN = Symbol.for('ChannelAdapters');
