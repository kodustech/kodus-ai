import { Entity } from '@libs/core/domain/interfaces/entity';
import { IUserNotification } from '../interfaces/user-notification.interface';

export class UserNotificationEntity implements Entity<IUserNotification> {
    private _uuid: string;
    private _userId: string;
    private _deliveryId: string;
    private _readAt?: Date | null;
    private _createdAt?: Date;

    private constructor(
        data: IUserNotification | Partial<IUserNotification>,
    ) {
        // Handle model with relation objects (user.uuid, delivery.uuid)
        const dataWithRelations = data as Partial<IUserNotification> & {
            user?: { uuid?: string };
            delivery?: { uuid?: string };
        };

        this._uuid = data.uuid;
        this._userId =
            dataWithRelations.userId ?? dataWithRelations.user?.uuid;
        this._deliveryId =
            dataWithRelations.deliveryId ?? dataWithRelations.delivery?.uuid;
        this._readAt = data.readAt;
        this._createdAt = data.createdAt;
    }

    public static create(
        data: IUserNotification | Partial<IUserNotification>,
    ): UserNotificationEntity {
        return new UserNotificationEntity(data);
    }

    public get uuid() {
        return this._uuid;
    }
    public get userId() {
        return this._userId;
    }
    public get deliveryId() {
        return this._deliveryId;
    }
    public get readAt() {
        return this._readAt;
    }
    public get createdAt() {
        return this._createdAt;
    }

    public toObject(): IUserNotification {
        return {
            uuid: this._uuid,
            userId: this._userId,
            deliveryId: this._deliveryId,
            readAt: this._readAt,
            createdAt: this._createdAt,
        };
    }

    public toJson(): Partial<IUserNotification> {
        return this.toObject();
    }
}
