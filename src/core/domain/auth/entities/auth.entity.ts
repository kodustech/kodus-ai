import { Entity } from '@/shared/domain/interfaces/entity';
import { IUser } from '../../user/interfaces/user.interface';
import { IAuth } from '../interfaces/auth.interface';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';

export class AuthEntity implements Entity<IAuth> {
    private _uuid: string;
    private _user?: IUser;
    private _refreshToken: string;
    private _used: boolean;
    private _expiryDate: Date;
    private _authDetails: any;
    private _authProvider: AuthProvider;

    constructor(auth: IAuth | Partial<IAuth>) {
        this._uuid = auth.uuid;
        this._user = auth?.user;
        this._refreshToken = auth.refreshToken;
        this._used = auth.used;
        this._expiryDate = auth.expiryDate;
        this._authDetails = auth.authDetails;
        this._authProvider = auth.authProvider;
    }

    public static create(auth: IAuth | Partial<IAuth>): AuthEntity {
        return new AuthEntity(auth);
    }

    public get uuid() {
        return this._uuid;
    }

    public get user() {
        return this._user;
    }

    public get refreshToken() {
        return this._refreshToken;
    }

    public get used() {
        return this._used;
    }

    public get expiryDate() {
        return this._expiryDate;
    }

    public get authDetails() {
        return this._authDetails;
    }

    public get authProvider() {
        return this._authProvider;
    }

    public toObject(): IAuth {
        return {
            uuid: this._uuid,
            user: this._user,
            refreshToken: this._refreshToken,
            used: this._used,
            expiryDate: this._expiryDate,
            authDetails: this._authDetails,
            authProvider: this._authProvider,
        };
    }

    public toJson(): IAuth | Partial<IAuth> {
        return {
            uuid: this._uuid,
            user: this._user,
            refreshToken: this._refreshToken,
            used: this._used,
            expiryDate: this._expiryDate,
            authDetails: this._authDetails,
            authProvider: this._authProvider,
        };
    }
}
