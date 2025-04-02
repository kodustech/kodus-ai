import { ITeam } from '../../team/interfaces/team.interface';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { IParameters } from '../interfaces/parameters.interface';

export class ParametersEntity implements IParameters {
    private _uuid: string;
    private _configKey: ParametersKey;
    private _configValue: any;
    private _team?: Partial<ITeam>;

    constructor(parameters: IParameters | Partial<IParameters>) {
        this._uuid = parameters.uuid;
        this._configKey = parameters.configKey;
        this._configValue = parameters.configValue;
        this._team = parameters.team;
    }

    public static create(parameters: IParameters | Partial<IParameters>) {
        return new ParametersEntity(parameters);
    }

    public get uuid() {
        return this._uuid;
    }

    public get configKey() {
        return this._configKey;
    }

    public get configValue() {
        return this._configValue;
    }

    public get team() {
        return this._team;
    }
}
