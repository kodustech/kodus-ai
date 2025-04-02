import { IProfile } from '@/core/domain/profile/interfaces/profile.interface';
import { IProfileRepository } from './profile.repository.contract';

export const PROFILE_SERVICE_TOKEN = Symbol('ProfileService');

export interface IProfileService extends IProfileRepository {
    updateByUserId(user_id: string, data: Partial<IProfile>): Promise<void>;
}
