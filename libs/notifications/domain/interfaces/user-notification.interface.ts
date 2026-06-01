export interface IUserNotification {
    uuid?: string;
    userId: string;
    deliveryId: string;
    readAt?: Date | null;
    createdAt?: Date;
}
