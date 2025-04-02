import { IProfile } from "../../profile/interfaces/profile.interface";
import { ProfileConfigKey } from "../enum/profileConfigKey.enum";

export interface IProfileConfig {
    uuid: string;
    configKey: ProfileConfigKey;
    configValue: any;
    status: boolean;
    profile?: Partial<IProfile>;
}
