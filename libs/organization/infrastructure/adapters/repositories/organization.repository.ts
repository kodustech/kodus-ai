import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createLogger } from '@libs/core/log/logger';
import {
    FindManyOptions,
    FindOneOptions,
    In,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';

import { OrganizationModel } from './schemas/organization.model';

import { IOrganizationRepository } from '@libs/organization/domain/organization/contracts/organization.repository.contract';
import { OrganizationEntity } from '@libs/organization/domain/organization/entities/organization.entity';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class OrganizationDatabaseRepository implements IOrganizationRepository {
    private readonly logger = createLogger(OrganizationDatabaseRepository.name);

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
            this.logger.error({
                message: 'Error finding organizations',
                context: OrganizationDatabaseRepository.name,
                error,
            });
        }
    }

    public async findOne(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
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
    }

    public async findById(uuid: string): Promise<OrganizationEntity> {
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
    }

    public async create(
        organizationEntity: IOrganization,
    ): Promise<OrganizationEntity> {
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
    }

    public async deleteOne(filter: Partial<IOrganization>): Promise<void> {
        const { users, teams, ...otherFilterAttributes } = filter;

        // Validate that filter is not empty to prevent unbounded delete
        const hasValidFilter =
            Object.keys(otherFilterAttributes).length > 0 ||
            (users && users.length > 0) ||
            (teams && teams.length > 0);

        if (!hasValidFilter) {
            throw new Error(
                'Delete operation requires at least one filter criterion to prevent accidental mass deletion',
            );
        }

        // Use find-then-delete approach to handle relation filtering correctly
        // TypeORM's delete() method doesn't support relation filtering
        const organizationToDelete = await this.findOne(filter);

        if (!organizationToDelete) {
            throw new Error(
                'No matching organization found or deletion failed',
            );
        }

        // Delete by uuid (primary key) to ensure safe, targeted deletion
        const result = await this.organizationRepository.delete({
            uuid: organizationToDelete.uuid,
        });

        if (result.affected === 0) {
            throw new Error(
                'No matching organization found or deletion failed',
            );
        }
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
            this.logger.error({
                message: 'Error updating organization',
                context: OrganizationDatabaseRepository.name,
                error,
            });
        }
    }
}
