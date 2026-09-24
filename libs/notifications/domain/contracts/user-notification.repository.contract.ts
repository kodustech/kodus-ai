import { IUserNotification } from '../interfaces/user-notification.interface';

export interface UserNotificationWithDelivery extends IUserNotification {
    delivery: {
        uuid: string;
        event: string;
        criticality: string;
        title: string;
        body: string;
        ctaUrl?: string;
        category: string;
        metadata: Record<string, unknown>;
        createdAt: Date;
    };
}

export interface IUserNotificationRepository {
    create(notification: Omit<IUserNotification, 'uuid'>): Promise<IUserNotification>;

    /** `organizationId` scopes the feed to the active tenant — a person in
     *  several organizations must not see another one's notifications. */
    findByUser(
        userId: string,
        options: {
            limit: number;
            offset: number;
            unreadOnly?: boolean;
            organizationId?: string;
        },
    ): Promise<{ data: UserNotificationWithDelivery[]; total: number }>;

    // organizationId is required in practice: an absent tenant returns
    // nothing rather than everything, so a missing scope can never widen a
    // read or a write across organizations.
    countUnread(userId: string, organizationId?: string): Promise<number>;

    markAsRead(
        notificationId: string,
        userId: string,
        organizationId?: string,
    ): Promise<void>;

    markAllAsRead(userId: string, organizationId?: string): Promise<number>;
}

export const USER_NOTIFICATION_REPOSITORY_TOKEN = Symbol.for(
    'UserNotificationRepository',
);
