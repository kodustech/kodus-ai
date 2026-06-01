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

    findByUser(
        userId: string,
        options: { limit: number; offset: number; unreadOnly?: boolean },
    ): Promise<{ data: UserNotificationWithDelivery[]; total: number }>;

    countUnread(userId: string): Promise<number>;

    markAsRead(notificationId: string, userId: string): Promise<void>;

    markAllAsRead(userId: string): Promise<number>;
}

export const USER_NOTIFICATION_REPOSITORY_TOKEN = Symbol.for(
    'UserNotificationRepository',
);
