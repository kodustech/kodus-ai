import { Entity } from '@libs/core/domain/interfaces/entity';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    ITeamCliKey,
    ITeamCliKeyConfig,
} from '../interfaces/team-cli-key.interface';

export class TeamCliKeyEntity implements Entity<ITeamCliKey> {
    private _uuid: string;
    private _name: string;
    private _keyHash: string;
    private _keyPrefix?: string;
    private _active: boolean;
    private _config?: ITeamCliKeyConfig;
    private _lastUsedAt?: Date;
    private _createdAt?: Date;
    private _updatedAt?: Date;
    private _team?: Partial<ITeam>;
    private _createdBy?: Partial<IUser>;

    private constructor(teamCliKey: ITeamCliKey | Partial<ITeamCliKey>) {
        this._uuid = teamCliKey.uuid;
        this._name = teamCliKey.name;
        this._keyHash = teamCliKey.keyHash;
        this._keyPrefix = teamCliKey.keyPrefix;
        this._active = teamCliKey.active ?? true;
        this._config = teamCliKey.config;
        this._lastUsedAt = teamCliKey.lastUsedAt;
        this._createdAt = teamCliKey.createdAt;
        this._updatedAt = teamCliKey.updatedAt;
        this._team = teamCliKey.team;
        this._createdBy = teamCliKey.createdBy;
    }

    public static create(
        teamCliKey: ITeamCliKey | Partial<ITeamCliKey>,
    ): TeamCliKeyEntity {
        return new TeamCliKeyEntity(teamCliKey);
    }

    public get uuid() {
        return this._uuid;
    }

    public get name() {
        return this._name;
    }

    public get keyHash() {
        return this._keyHash;
    }

    public get keyPrefix() {
        return this._keyPrefix;
    }

    public get active() {
        return this._active;
    }

    public get config() {
        return this._config;
    }

    public get lastUsedAt() {
        return this._lastUsedAt;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get updatedAt() {
        return this._updatedAt;
    }

    public get team() {
        return this._team;
    }

    public get createdBy() {
        return this._createdBy;
    }

    public toObject(): ITeamCliKey {
        return {
            uuid: this._uuid,
            name: this._name,
            keyHash: this._keyHash,
            keyPrefix: this._keyPrefix,
            active: this._active,
            config: this._config,
            lastUsedAt: this._lastUsedAt,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
            team: this._team,
            createdBy: this._createdBy,
        };
    }

    public toJson(): Partial<ITeamCliKey> {
        return {
            uuid: this._uuid,
            name: this._name,
            active: this._active,
            config: this._config,
            lastUsedAt: this._lastUsedAt,
            createdAt: this._createdAt,
            team: this._team,
        };
    }
}
