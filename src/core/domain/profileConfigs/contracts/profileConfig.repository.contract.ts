import { ProfileConfigEntity } from '../entities/profileConfig.entity';
import { IProfileConfig } from '../interfaces/profileConfig.interface';

export const PROFILE_CONFIG_REPOSITORY_TOKEN = Symbol(
    'ProfileConfigRepository',
);

export interface IProfileConfigRepository {
    find(filter?: Partial<IProfileConfig>): Promise<ProfileConfigEntity[]>;
    findOne(filter?: Partial<IProfileConfig>): Promise<ProfileConfigEntity>;
    create(
        profileConfig: IProfileConfig,
    ): Promise<ProfileConfigEntity | undefined>;
    update(
        filter: Partial<IProfileConfig>,
        data: Partial<IProfileConfig>,
    ): Promise<ProfileConfigEntity | undefined>;
    delete(uuid: string): Promise<void>;
}
