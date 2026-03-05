import { Entity } from '@libs/core/domain/interfaces/entity';
import { ICliDevice } from '../interfaces/cli-device.interface';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

export class CliDeviceEntity implements Entity<ICliDevice> {
    private _uuid: string;
    private _deviceId: string;
    private _deviceTokenHash: string;
    private _organization?: Partial<IOrganization>;
    private _user?: Partial<IUser>;
    private _lastSeenAt?: Date;
    private _userAgent?: string;
    private _createdAt?: Date;
    private _updatedAt?: Date;

    private constructor(data: ICliDevice | Partial<ICliDevice>) {
        this._uuid = data.uuid;
        this._deviceId = data.deviceId;
        this._deviceTokenHash = data.deviceTokenHash;
        this._organization = data.organization;
        this._user = data.user;
        this._lastSeenAt = data.lastSeenAt;
        this._userAgent = data.userAgent;
        this._createdAt = data.createdAt;
        this._updatedAt = data.updatedAt;
    }

    public static create(
        data: ICliDevice | Partial<ICliDevice>,
    ): CliDeviceEntity {
        return new CliDeviceEntity(data);
    }

    public get uuid() {
        return this._uuid;
    }
    public get deviceId() {
        return this._deviceId;
    }
    public get deviceTokenHash() {
        return this._deviceTokenHash;
    }
    public get organization() {
        return this._organization;
    }
    public get user() {
        return this._user;
    }
    public get lastSeenAt() {
        return this._lastSeenAt;
    }
    public get userAgent() {
        return this._userAgent;
    }
    public get createdAt() {
        return this._createdAt;
    }
    public get updatedAt() {
        return this._updatedAt;
    }

    public toObject(): ICliDevice {
        return {
            uuid: this._uuid,
            deviceId: this._deviceId,
            deviceTokenHash: this._deviceTokenHash,
            organization: this._organization,
            user: this._user,
            lastSeenAt: this._lastSeenAt,
            userAgent: this._userAgent,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    public toJson(): Partial<ICliDevice> {
        return {
            uuid: this._uuid,
            deviceId: this._deviceId,
            lastSeenAt: this._lastSeenAt,
            createdAt: this._createdAt,
        };
    }
}
