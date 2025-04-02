import { IOrganizationRepository } from '@/core/domain/organization/contracts/organization.repository.contract';
import { OrganizationEntity } from '@/core/domain/organization/entities/organization.entity';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    In,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import { OrganizationModel } from './schema/organization.model';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';

@Injectable()
export class OrganizationDatabaseRepository implements IOrganizationRepository {
    constructor(
        @InjectRepository(OrganizationModel)
        private readonly organizationRepository: Repository<OrganizationModel>,
    ) {}

    public async find(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity[]> {
        try {
            const { users, teams, ...otherFilterAttributes } = filter;

            const findOneOptions: FindManyOptions<OrganizationModel> = {
                where: {
                    ...otherFilterAttributes,
                },
                relations: ['users'],
            };

            if (users) {
                findOneOptions.where = {
                    ...findOneOptions.where,
                    users: {
                        uuid: In(users.map((user) => user.uuid)),
                    },
                };
            }

            if (teams) {
                findOneOptions.where = {
                    ...findOneOptions.where,
                    teams: {
                        uuid: In(teams.map((team) => team.uuid)),
                    },
                };
            }

            const organizationModel =
                await this.organizationRepository.find(findOneOptions);
            return mapSimpleModelsToEntities(
                organizationModel,
                OrganizationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    public async findOne(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
        try {
            const { users, teams, ...otherFilterAttributes } = filter;

            const findOneOptions: FindOneOptions<OrganizationModel> = {
                where: {
                    ...otherFilterAttributes,
                },
                relations: ['users'],
            };

            if (users?.every((user) => user?.uuid)) {
                // Filter the organization by associated users using the subquery
                findOneOptions.where = {
                    ...findOneOptions.where,
                    users: {
                        uuid: In(users.map((user) => user.uuid)),
                    },
                };
            }

            if (teams?.every((team) => team?.uuid)) {
                findOneOptions.where = {
                    ...findOneOptions.where,
                    teams: {
                        uuid: In(teams.map((team) => team.uuid)),
                    },
                };
            }

            const organizationSelected =
                await this.organizationRepository.findOne(findOneOptions);

            if (organizationSelected) {
                return mapSimpleModelToEntity(
                    organizationSelected,
                    OrganizationEntity,
                );
            }

            return undefined;
        } catch (error) {}
    }

    public async findById(uuid: string): Promise<OrganizationEntity> {
        try {
            const queryBuilder =
                this.organizationRepository.createQueryBuilder('organization');

            const organizationSelected = await queryBuilder
                .innerJoinAndSelect('organization.user', 'user')
                .where('user.uuid = :uuid', { uuid })
                .getOne();

            if (organizationSelected) {
                return mapSimpleModelToEntity(
                    organizationSelected,
                    OrganizationEntity,
                );
            }

            return undefined;
        } catch (error) {}
    }

    public async create(
        organizationEntity: IOrganization,
    ): Promise<OrganizationEntity> {
        try {
            const queryBuilder =
                this.organizationRepository.createQueryBuilder('organization');

            const organizationModel =
                this.organizationRepository.create(organizationEntity);

            const organization = await queryBuilder
                .insert()
                .values(organizationModel)
                .execute();

            if (organization?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<OrganizationModel> = {
                    where: {
                        uuid: organization.identifiers[0].uuid,
                    },
                };

                const insertedOrganization =
                    await this.organizationRepository.findOne(findOneOptions);

                if (insertedOrganization) {
                    return mapSimpleModelToEntity(
                        insertedOrganization,
                        OrganizationEntity,
                    );
                }
            }

            return undefined;
        } catch (error) {}
    }

    public async deleteOne(filter: Partial<IOrganization>): Promise<void> {
        try {
            const { users, teams, ...otherFilterAttributes } = filter;

            const result = await this.organizationRepository.delete({
                ...otherFilterAttributes,
                users: {
                    uuid: In(users.map((user) => user.uuid)),
                },
                teams: {
                    uuid: In(teams.map((team) => team.uuid)),
                },
            });

            if (result.affected === 0) {
                throw new Error(
                    'No matching organization found or deletion failed',
                );
            }
        } catch (error) {}
    }

    public async update(
        filter: Partial<IOrganization>,
        data: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<OrganizationModel> =
                this.organizationRepository
                    .createQueryBuilder('organizations')
                    .update(OrganizationModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { users, teams, ...otherFilterAttributes } = filter || {};

                const usersCondition = createNestedConditions('users', users);

                const teamsCondition = createNestedConditions('teams', teams);

                const findOptions: FindManyOptions<OrganizationModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...usersCondition,
                        ...teamsCondition,
                    },
                };

                const organization =
                    await this.organizationRepository.findOne(findOptions);

                return mapSimpleModelToEntity(organization, OrganizationEntity);
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }
}
