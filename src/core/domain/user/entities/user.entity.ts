import { Entity } from '@/shared/domain/interfaces/entity';
import { IUser } from '../interfaces/user.interface';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ITeamMember } from '../../teamMembers/interfaces/team-members.interface';
import { STATUS } from '@/config/types/database/status.type';
import { UserRole } from '../enums/userRole.enum';

export class UserEntity implements Entity<IUser> {
    private _uuid: string;
    private _email: string;
    private _password: string;
    private _role: UserRole[];
    private _organization?: Partial<IOrganization>;
    private _status: STATUS;
    private _teamMember?: Partial<ITeamMember>[];

    private constructor(user: IUser | Partial<IUser>) {
        this._uuid = user.uuid;
        this._email = user.email;
        this._password = user.password;
        this._role = user.role;
        this._organization = user.organization;
        this._status = user.status;
        this._teamMember = user.teamMember;
    }

    public static create(user: IUser | Partial<IUser>): UserEntity {
        return new UserEntity(user);
    }

    public get uuid() {
        return this._uuid;
    }

    public get email() {
        return this._email;
    }

    public get password() {
        return this._password;
    }

    public get role() {
        return this._role;
    }

    public get organization() {
        return this._organization;
    }

    public get status() {
        return this._status;
    }

    public get teamMember() {
        return this._teamMember;
    }

    public toObject(): IUser {
        return {
            uuid: this._uuid,
            email: this._email,
            password: undefined,
            role: this._role,
            organization: this._organization,
            status: this._status,
            teamMember: this._teamMember,
        };
    }

    public toJson(): Partial<IUser> {
        return {
            email: this._email,
        };
    }
}
