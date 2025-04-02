import { ISession } from '../interfaces/session.interface';

export class SessionEntity implements ISession {
    private _uuid: string;
    private _platformUserId: string;
    private _platformName: string;
    private _date: number;
    private _route: string;
    private _organizationId: string;
    private _teamId: string;

    constructor(session: ISession | Partial<ISession>) {
        this._uuid = session.uuid;
        this._platformUserId = session.platformUserId;
        this._platformName = session.platformName;
        this._date = session.date;
        this._route = session.route;
        this._organizationId = session.organizationId;
        this._teamId = session.teamId;
    }

    public static create(session: ISession | Partial<ISession>): SessionEntity {
        return new SessionEntity(session);
    }

    get uuid(): string {
        return this._uuid;
    }

    get platformUserId(): string {
        return this._platformUserId;
    }

    get platformName(): string {
        return this._platformName;
    }

    get date(): number {
        return this._date;
    }

    get route(): string {
        return this._route;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get teamId(): string {
        return this._teamId;
    }
}
