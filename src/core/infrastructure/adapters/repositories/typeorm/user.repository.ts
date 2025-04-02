import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    FindOptionsWhere,
    In,
    Repository,
} from 'typeorm';

import { IUserRepository } from '@/core/domain/user/contracts/user.repository.contract';
import { UserEntity } from '@/core/domain/user/entities/user.entity';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { mapSimpleModelToEntity } from '@/shared/infrastructure/repositories/mappers';
import { UserModel } from './schema/user.model';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class UserDatabaseRepository implements IUserRepository {
    constructor(
        @InjectRepository(UserModel)
        private readonly userRepository: Repository<UserModel>,
    ) {}
    async find(
        filter: Partial<IUser>,
        statusArray?: STATUS[],
    ): Promise<UserEntity[]> {
        const { organization, ...otherFilterAttributes } = filter;

        const whereCondition: any = {
            ...otherFilterAttributes,
            role: filter.role ? In(filter.role) : undefined,
            teamMember: filter.teamMember
                ? (filter.teamMember as any)
                : undefined,
        };

        // Remove undefined values
        Object.keys(whereCondition).forEach((key) => {
            if (whereCondition[key] === undefined) {
                delete whereCondition[key];
            }
        });

        // Add status to the whereCondition
        if (statusArray && statusArray.length > 0) {
            whereCondition.status = In(statusArray);
        }

        // Handle organization filters
        if (organization) {
            whereCondition.organization = {};
            if (organization.name) {
                whereCondition.organization.name = organization.name;
            }
            if (organization.uuid) {
                whereCondition.organization.uuid = organization.uuid;
            }
        }

        const findOptions: FindManyOptions<UserModel> = {
            where: whereCondition,
            relations: [
                'organization',
                'teamMember',
                'teamMember.organization',
                'teamMember.team',
            ],
        };

        const userModel = await this.userRepository.find(findOptions);

        return userModel.map((user) =>
            mapSimpleModelToEntity(user, UserEntity),
        );
    }

    async findOne(filter: Partial<IUser>): Promise<UserEntity | undefined> {
        const { organization, status, ...otherFilterAttributes } = filter;

        const whereCondition: any = {};

        Object.keys(otherFilterAttributes).forEach((key) => {
            if (otherFilterAttributes[key] !== undefined) {
                whereCondition[key] = otherFilterAttributes[key];
            }
        });

        // Adds support for status array
        if (status) {
            whereCondition.status = Array.isArray(status) ? In(status) : status;
        }

        if (filter.role) {
            whereCondition.role = In(filter.role);
        }
        if (filter.teamMember) {
            whereCondition.teamMember = filter.teamMember;
        }

        if (organization) {
            whereCondition.organization = {};
            if (organization.name) {
                whereCondition.organization.name = organization.name;
            }
            if (organization.uuid) {
                whereCondition.organization.uuid = organization.uuid;
            }
        }

        const findOneOptions: FindOneOptions<UserModel> = {
            where: whereCondition,
            relations: [
                'organization',
                'teamMember',
                'teamMember.organization',
                'teamMember.team',
            ],
        };

        const userSelected = await this.userRepository.findOne(findOneOptions);

        if (userSelected) {
            return mapSimpleModelToEntity(userSelected, UserEntity);
        }

        return undefined;
    }

    async findUsersWithEmailsInDifferentOrganizations(
        emails: string[],
        organizationId: string,
    ): Promise<UserEntity[]> {
        const queryBuilder = this.userRepository.createQueryBuilder('user');
        queryBuilder
            .where('user.email IN (:...emails)', { emails })
            .andWhere('user.organization.uuid != :organizationId', {
                organizationId,
            });

        const users = await queryBuilder.getMany();
        return users.map((user) => mapSimpleModelToEntity(user, UserEntity));
    }

    async count(filter: Partial<IUser>): Promise<number> {
        try {
            const { organization, ...otherFilterAttributes } = filter;

            const findOneOptions: FindOneOptions<UserModel> = {
                where: {
                    ...otherFilterAttributes,
                    role: filter.role ? In(filter.role) : undefined,
                    teamMember: filter.teamMember
                        ? (filter.teamMember as any)
                        : undefined,
                },
                relations: ['organization', 'profile'],
            };

            if (organization) {
                // Add organization filter criteria
                findOneOptions.where = {
                    ...findOneOptions.where,
                    organization: {
                        name: organization.name,
                    },
                };
            }

            return this.userRepository.count(findOneOptions);
        } catch (error) {
            console.log(error);
        }
    }

    async getLoginData(email: string): Promise<UserEntity | undefined> {
        try {
            const queryBuilder =
                this.userRepository.createQueryBuilder('users');

            // Join with the 'organization' relation and select only the 'uuid'
            queryBuilder
                .leftJoinAndSelect('users.organization', 'organization')
                .where('users.email = :email', { email });

            const userSelected = await queryBuilder.getOne();

            if (userSelected) {
                userSelected.organization = {
                    uuid: userSelected.organization.uuid,
                } as any;

                return mapSimpleModelToEntity(userSelected, UserEntity);
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async getCryptedPassword(email: string): Promise<string | undefined> {
        const queryBuilder = this.userRepository.createQueryBuilder('user');

        const userSelected = await queryBuilder
            .where('user.email = :email', { email })
            .getOne();

        return userSelected?.password;
    }

    async findById(uuid: string): Promise<UserEntity | undefined> {
        const queryBuilder = this.userRepository.createQueryBuilder('user');

        const userSelected = await queryBuilder
            .where('user.uuid = :uuid', { uuid })
            .getOne();

        if (userSelected) {
            return mapSimpleModelToEntity(userSelected, UserEntity);
        }

        return undefined;
    }

    async create(userEntity: IUser): Promise<UserEntity | undefined> {
        const queryBuilder = this.userRepository.createQueryBuilder('user');

        const userModel = this.userRepository.create(userEntity);
        const user = await queryBuilder.insert().values(userModel).execute();

        if (user?.identifiers[0]?.uuid) {
            const findOneOptions: FindOneOptions<UserModel> = {
                where: {
                    uuid: user.identifiers[0].uuid,
                },
                relations: ['organization'],
            };

            const insertedUser =
                await this.userRepository.findOne(findOneOptions);

            if (insertedUser) {
                return mapSimpleModelToEntity(insertedUser, UserEntity);
            }
        }

        return undefined;
    }
    async update(
        filter: Partial<IUser>,
        data: Partial<IUser>,
    ): Promise<UserEntity | undefined> {
        try {
            const queryBuilder = this.userRepository
                .createQueryBuilder('user')
                .update(UserModel)
                .set(data)
                .where(filter);

            const result = await queryBuilder.execute();

            if (result.affected && result.affected > 0) {
                const findOneOptions: FindOptionsWhere<UserModel> = {
                    ...(filter as unknown as FindOptionsWhere<UserModel>),
                };

                const updatedUser = await this.userRepository.findOne({
                    where: findOneOptions,
                });

                if (updatedUser) {
                    return mapSimpleModelToEntity(updatedUser, UserEntity);
                }
            }

            return undefined;
        } catch (error) {
            // Logging the error and throwing an exception
            console.error('Error updating user:', error);
            throw new Error('Failed to update user');
        }
    }

    async delete(uuid: string): Promise<void> {
        await this.userRepository
            .createQueryBuilder()
            .update(UserModel)
            .set({ status: STATUS.REMOVED })
            .where('uuid = :uuid', { uuid: uuid })
            .execute();
    }

    async findProfileIdsByOrganizationAndRole(
        organizationId: string,
        role: UserRole,
    ): Promise<string[]> {
        try {
            const queryBuilder =
                this.userRepository.createQueryBuilder('users');

            queryBuilder
                .innerJoinAndSelect('users.profile', 'profile')
                .where('users.organization_id = :organizationId', {
                    organizationId,
                })
                .andWhere('users.role = :role', { role });

            const users = await queryBuilder.getMany();

            return users?.map((user: any) => user.profile.uuid) || [];
        } catch (error) {
            console.log(error);
        }
    }
}
