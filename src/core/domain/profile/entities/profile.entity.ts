import { Entity } from '@/shared/domain/interfaces/entity';

import { IProfile } from '../interfaces/profile.interface';
import { IUser } from '@/core/domain/user/interfaces/user.interface';

export class ProfileEntity implements Entity<IProfile> {
    private _uuid: string;
    private _name: string;
    private _phone?: string;
    private _img?: string;
    private _position?: string;
    private _user?: Partial<IUser>;
    private _status: boolean;

    constructor(profile: IProfile) {
        this._uuid = profile.uuid;
        this._name = profile.name;
        this._phone = profile.phone;
        this._img = profile.img;
        this._position = profile.position;
        this._user = profile?.user;
        this._status = profile.status;
    }

    public static create(profile: IProfile) {
        return new ProfileEntity(profile);
    }

    public get uuid() {
        return this._uuid;
    }

    public get name() {
        return this._name;
    }

    public get phone() {
        return this._phone;
    }

    public get img() {
        return this._img;
    }

    public get position() {
        return this._position;
    }

    public get user() {
        return this._user;
    }

    public get status() {
        return this._status;
    }

    public toObject(): IProfile {
        return {
            uuid: this._uuid,
            name: this._name,
            phone: this._phone,
            img: this._img,
            position: this._position,
            status: this._status,
        };
    }

    public toJson(): IProfile {
        return {
            uuid: this._uuid,
            name: this._name,
            phone: this._phone,
            img: this._img,
            position: this._position,
            status: this._status,
        };
    }
}
