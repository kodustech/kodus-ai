import { INotificationDelivery } from '../interfaces/notification-delivery.interface';

export interface INotificationDeliveryRepository {
    create(
        delivery: Omit<INotificationDelivery, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<INotificationDelivery>;

    /**
     * Mark a delivery as terminally done (DELIVERED or FAILED). Use
     * {@link scheduleRetry} when the row should be re-attempted instead.
     */
    updateStatus(
        deliveryId: string,
        status: INotificationDelivery['deliveryStatus'],
        error?: string,
    ): Promise<void>;

    /**
     * Schedule a retry for a failed attempt. Increments attempts, sets
     * nextAttemptAt, stores the error, and clears the lock so the
     * worker can pick the row up again when the time comes.
     */
    scheduleRetry(
        deliveryId: string,
        nextAttemptAt: Date,
        error: string,
    ): Promise<void>;

    /**
     * Atomically claim a batch of pending deliveries whose nextAttemptAt
     * has elapsed. Uses SELECT … FOR UPDATE SKIP LOCKED so concurrent
     * workers don't double-process the same row.
     */
    claimRetryBatch(
        limit: number,
        lockedBy: string,
    ): Promise<INotificationDelivery[]>;

    findByCorrelationId(correlationId: string): Promise<INotificationDelivery[]>;
}

export const NOTIFICATION_DELIVERY_REPOSITORY_TOKEN = Symbol.for(
    'NotificationDeliveryRepository',
);
