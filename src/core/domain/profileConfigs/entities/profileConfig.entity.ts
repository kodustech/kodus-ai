import { IProfile } from "../../profile/interfaces/profile.interface";
import { ProfileConfigKey } from "../enum/profileConfigKey.enum";
import { IProfileConfig } from "../interfaces/profileConfig.interface";

export class ProfileConfigEntity implements IProfileConfig {
    private _uuid: string;
    private _configKey: ProfileConfigKey;
    private _configValue: any;
    private _status: boolean;
    private _profile?: Partial<IProfile>;

    constructor(profileConfig: IProfileConfig | Partial<IProfileConfig>) {
        this._uuid = profileConfig.uuid;
        this._configKey = profileConfig.configKey;
        this._configValue = profileConfig.configValue;
        this._status = profileConfig.status;
        this._profile = profileConfig.profile;
    }

    public static create(profileConfig: IProfileConfig | Partial<IProfileConfig>) {
        return new ProfileConfigEntity(profileConfig);
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

    public get status() {
        return this._status;
    }

    public get profile() {
        return this._profile;
    }
}
