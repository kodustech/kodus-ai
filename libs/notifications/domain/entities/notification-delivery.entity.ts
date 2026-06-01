import { Entity } from '@libs/core/domain/interfaces/entity';
import { INotificationDelivery } from '../interfaces/notification-delivery.interface';
import { Criticality, DeliveryStatus, NotificationChannel } from '../enums';

export class NotificationDeliveryEntity
    implements Entity<INotificationDelivery>
{
    private _uuid: string;
    private _organization?: { uuid?: string };
    private _recipientUser?: { uuid?: string };
    private _event: string;
    private _criticality: Criticality;
    private _channel: NotificationChannel;
    private _title: string;
    private _body: string;
    private _ctaUrl?: string;
    private _category: string;
    private _recipientEmail?: string;
    private _recipientRole?: string;
    private _deliveryStatus: DeliveryStatus;
    private _metadata: Record<string, unknown>;
    private _correlationId: string;
    private _lastError?: string;
    private _deliveredAt?: Date;
    private _attempts: number;
    private _nextAttemptAt?: Date | null;
    private _lockedAt?: Date | null;
    private _lockedBy?: string | null;
    private _createdAt?: Date;
    private _updatedAt?: Date;

    private constructor(
        data: INotificationDelivery | Partial<INotificationDelivery>,
    ) {
        this._uuid = data.uuid;
        this._organization = data.organization;
        this._recipientUser = data.recipientUser;
        this._event = data.event;
        this._criticality = data.criticality;
        this._channel = data.channel;
        this._title = data.title;
        this._body = data.body;
        this._ctaUrl = data.ctaUrl;
        this._category = data.category;
        this._recipientEmail = data.recipientEmail;
        this._recipientRole = data.recipientRole;
        this._deliveryStatus = data.deliveryStatus;
        this._metadata = data.metadata;
        this._correlationId = data.correlationId;
        this._lastError = data.lastError;
        this._deliveredAt = data.deliveredAt;
        this._attempts = data.attempts ?? 0;
        this._nextAttemptAt = data.nextAttemptAt;
        this._lockedAt = data.lockedAt;
        this._lockedBy = data.lockedBy;
        this._createdAt = data.createdAt;
        this._updatedAt = data.updatedAt;
    }

    public static create(
        data: INotificationDelivery | Partial<INotificationDelivery>,
    ): NotificationDeliveryEntity {
        return new NotificationDeliveryEntity(data);
    }

    public get uuid() {
        return this._uuid;
    }
    public get organization() {
        return this._organization;
    }
    public get recipientUser() {
        return this._recipientUser;
    }
    public get event() {
        return this._event;
    }
    public get criticality() {
        return this._criticality;
    }
    public get channel() {
        return this._channel;
    }
    public get title() {
        return this._title;
    }
    public get body() {
        return this._body;
    }
    public get ctaUrl() {
        return this._ctaUrl;
    }
    public get category() {
        return this._category;
    }
    public get recipientEmail() {
        return this._recipientEmail;
    }
    public get recipientRole() {
        return this._recipientRole;
    }
    public get deliveryStatus() {
        return this._deliveryStatus;
    }
    public get metadata() {
        return this._metadata;
    }
    public get correlationId() {
        return this._correlationId;
    }
    public get lastError() {
        return this._lastError;
    }
    public get deliveredAt() {
        return this._deliveredAt;
    }
    public get attempts() {
        return this._attempts;
    }
    public get nextAttemptAt() {
        return this._nextAttemptAt;
    }
    public get lockedAt() {
        return this._lockedAt;
    }
    public get lockedBy() {
        return this._lockedBy;
    }
    public get createdAt() {
        return this._createdAt;
    }
    public get updatedAt() {
        return this._updatedAt;
    }

    public toObject(): INotificationDelivery {
        return {
            uuid: this._uuid,
            organization: this._organization,
            recipientUser: this._recipientUser,
            event: this._event,
            criticality: this._criticality,
            channel: this._channel,
            title: this._title,
            body: this._body,
            ctaUrl: this._ctaUrl,
            category: this._category,
            recipientEmail: this._recipientEmail,
            recipientRole: this._recipientRole,
            deliveryStatus: this._deliveryStatus,
            metadata: this._metadata,
            correlationId: this._correlationId,
            lastError: this._lastError,
            deliveredAt: this._deliveredAt,
            attempts: this._attempts,
            nextAttemptAt: this._nextAttemptAt,
            lockedAt: this._lockedAt,
            lockedBy: this._lockedBy,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    public toJson(): Partial<INotificationDelivery> {
        return this.toObject();
    }
}
