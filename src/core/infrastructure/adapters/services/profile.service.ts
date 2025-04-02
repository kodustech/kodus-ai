import {
    IProfileRepository,
    PROFILE_REPOSITORY_TOKEN,
} from '@/core/domain/profile/contracts/profile.repository.contract';
import { IProfileService } from '@/core/domain/profile/contracts/profile.service.contract';
import { ProfileEntity } from '@/core/domain/profile/entities/profile.entity';
import { IProfile } from '@/core/domain/profile/interfaces/profile.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ProfilesService implements IProfileService {
    constructor(
        @Inject(PROFILE_REPOSITORY_TOKEN)
        private readonly profileRepository: IProfileRepository,
    ) {}

    update(
        filter: Partial<IProfile>,
        data: Partial<IProfile>,
    ): Promise<ProfileEntity | undefined> {
        return this.profileRepository.update(filter, data);
    }

    find(filter: Partial<IProfile>): Promise<ProfileEntity[]> {
        return this.profileRepository.find(filter);
    }
    findOne(filter: Partial<IProfile>): Promise<ProfileEntity> {
        return this.profileRepository.findOne(filter);
    }
    findById(uuid: string): Promise<ProfileEntity> {
        return this.profileRepository.findById(uuid);
    }
    create(profileEntity: IProfile): Promise<ProfileEntity> {
        return this.profileRepository.create(profileEntity);
    }
    deleteOne(filter: Partial<IProfile>): Promise<void> {
        return this.profileRepository.deleteOne(filter);
    }

    async updateByUserId(
        user_id: string,
        data: Partial<IProfile>,
    ): Promise<void> {
        await this.profileRepository.updateByUserId(user_id, data);
    }
}
