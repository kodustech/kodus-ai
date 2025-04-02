import { Entity } from '@/shared/domain/interfaces/entity';
import { ITeam } from '../interfaces/team.interface';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';
import { STATUS } from '@/config/types/database/status.type';

export class TeamEntity implements Entity<ITeam> {
    private _uuid: string;
    private _name: string;
    private _organization?: Partial<IOrganization>;
    private _status: STATUS;

    private constructor(team: ITeam | Partial<ITeam>) {
        this._uuid = team.uuid;
        this._name = team.name;
        this._organization = team.organization;
        this._status = team.status;
    }

    public static create(team: ITeam | Partial<ITeam>): TeamEntity {
        return new TeamEntity(team);
    }

    public get uuid() {
        return this._uuid;
    }

    public get name() {
        return this._name;
    }

    public get organization() {
        return this._organization;
    }

    public get status() {
        return this._status;
    }

    public toObject(): ITeam {
        return {
            uuid: this._uuid,
            name: this._name,
            organization: this._organization,
            status: this._status,
        };
    }

    public toJson(): Partial<ITeam> {
        return {
            uuid: this._uuid,
            name: this._name,
            status: this._status,
        };
    }
}
