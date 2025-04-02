import { ProfileEntity } from '../entities/profile.entity';
import { IProfile } from '../interfaces/profile.interface';

export const PROFILE_REPOSITORY_TOKEN = Symbol('ProfileRepository');

export interface IProfileRepository {
    find(filter: Partial<IProfile>): Promise<ProfileEntity[]>;
    findOne(filter: Partial<IProfile>): Promise<ProfileEntity | undefined>;
    findById(uuid: string): Promise<ProfileEntity | undefined>;
    updateByUserId(user_id: string, data: Partial<IProfile>): Promise<void>;
    create(profileEntity: IProfile): Promise<ProfileEntity | undefined>;
    deleteOne(filter: Partial<IProfile>): Promise<void>;
    update(
        filter: Partial<IProfile>,
        data: Partial<IProfile>,
    ): Promise<ProfileEntity | undefined>;
}
