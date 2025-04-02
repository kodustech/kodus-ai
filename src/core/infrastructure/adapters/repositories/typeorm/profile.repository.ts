import { mapSimpleModelToEntity } from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    DeepPartial,
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import { ProfileModel } from './schema/profile.model';
import { IProfileRepository } from '@/core/domain/profile/contracts/profile.repository.contract';
import { ProfileEntity } from '@/core/domain/profile/entities/profile.entity';
import { IProfile } from '@/core/domain/profile/interfaces/profile.interface';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';

@Injectable()
export class ProfileDatabaseRepository implements IProfileRepository {
    constructor(
        @InjectRepository(ProfileModel)
        private readonly profileRepository: Repository<ProfileModel>,
    ) {}

    public async update(
        filter: Partial<IProfile>,
        data: Partial<IProfile>,
    ): Promise<ProfileEntity | undefined> {
        try {
            const queryBuilder: UpdateQueryBuilder<ProfileModel> =
                this.profileRepository
                    .createQueryBuilder('profiles')
                    .update(ProfileModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { user, ...otherFilterAttributes } = filter || {};

                const usersCondition = createNestedConditions('user', user);

                const findOptions: FindManyOptions<ProfileModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...usersCondition,
                    },
                };

                const profile =
                    await this.profileRepository.findOne(findOptions);

                return mapSimpleModelToEntity(profile, ProfileEntity);
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    public async find(filter: Partial<IProfile>): Promise<ProfileEntity[]> {
        const options: FindManyOptions<ProfileModel> = {
            where: filter as any,
        };
        const profileModel = await this.profileRepository.find(options);
        // You might need to perform a conversion between ProfileModel and ProfileEntity here
        return mapSimpleModelToEntity(profileModel, ProfileEntity);
    }

    public async findOne(filter: Partial<IProfile>): Promise<ProfileEntity> {
        if (!filter) return undefined;

        const findOneOptions: FindOneOptions<ProfileModel> = {
            where: {
                ...(filter as any),
            },
        };

        const profileSelected =
            await this.profileRepository.findOne(findOneOptions);

        if (profileSelected) {
            return mapSimpleModelToEntity(profileSelected, ProfileEntity);
        }

        return undefined;
    }

    public async findById(uuid: string): Promise<ProfileEntity> {
        const queryBuilder =
            this.profileRepository.createQueryBuilder('profiles');

        const profileSelected = await queryBuilder
            .where('user.uuid = :uuid', { uuid })
            .getOne();

        if (profileSelected) {
            return mapSimpleModelToEntity(profileSelected, ProfileEntity);
        }

        return undefined;
    }

    async updateByUserId(
        user_id: string,
        data: Partial<IProfile>,
    ): Promise<void> {
        try {
            await this.profileRepository.save({
                ...data,
                user: { uuid: user_id },
            });
        } catch (error) {
            console.log(error);
        }
    }

    public async create(profileEntity: IProfile): Promise<ProfileEntity> {
        const queryBuilder =
            this.profileRepository.createQueryBuilder('profile');

        const profileModel = this.profileRepository.create(
            profileEntity as any as DeepPartial<ProfileModel>,
        );
        const profile = await queryBuilder
            .insert()
            .values(profileModel)
            .execute();

        if (profile?.identifiers[0]?.uuid) {
            const findOneOptions: FindOneOptions<ProfileModel> = {
                where: {
                    uuid: profile.identifiers[0].uuid,
                },
            };

            const insertedProfile =
                await this.profileRepository.findOne(findOneOptions);

            if (insertedProfile) {
                return mapSimpleModelToEntity(insertedProfile, ProfileEntity);
            }
        }

        return undefined;
    }

    public async deleteOne(filter: Partial<IProfile>): Promise<void> {
        const result = await this.profileRepository.delete(filter as any);

        if (result.affected === 0) {
            throw new Error('No matching team found or deletion failed');
        }
    }
}
