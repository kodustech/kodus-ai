import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { Entity } from '@/shared/domain/interfaces/entity';
import { IOrganization } from '../interfaces/organization.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export class OrganizationEntity implements Entity<IOrganization> {
    private _uuid: string;
    private _name: string;
    private _tenantName: string;
    private _status: boolean;
    private _users?: Partial<IUser>[];
    private _teams?: Partial<ITeam>[];

    private constructor(organization: IOrganization | Partial<IOrganization>) {
        this._uuid = organization.uuid;
        this._name = organization.name;
        this._tenantName = organization.tenantName || this.generateTenantName();
        this._status = organization.status;
        this._users = organization.users;
        this._teams = organization.teams;
    }

    public static create(
        organization: IOrganization | Partial<IOrganization>,
    ): OrganizationEntity {
        return new OrganizationEntity(organization);
    }

    private generateTenantName(): string {
        return `${this._name}-${this._uuid}`;
    }

    public get uuid() {
        return this._uuid;
    }

    public get name() {
        return this._name;
    }

    public get tenantName() {
        return this._tenantName;
    }

    public get status() {
        return this._status;
    }

    public get user() {
        return this._users;
    }

    public get teams() {
        return this._teams;
    }

    public toObject(): IOrganization {
        return {
            uuid: this._uuid,
            name: this._name,
            tenantName: this._tenantName,
            status: this._status,
            users: this._users,
            teams: this._teams,
        };
    }

    public toJson(): Partial<IOrganization> {
        return {
            uuid: this._uuid,
            name: this._name,
            tenantName: this._tenantName,
            status: this._status,
            users: this._users,
            teams: this._teams,
        };
    }
}
