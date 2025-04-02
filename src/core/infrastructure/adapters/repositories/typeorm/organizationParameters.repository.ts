import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationParametersRepository } from '@/core/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { OrganizationParametersModel } from './schema/organizationParameters.model';
import { OrganizationParametersEntity } from '@/core/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@/core/domain/organizationParameters/interfaces/organizationParameters.interface';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';

@Injectable()
export class OrganizationParametersRepository implements IOrganizationParametersRepository {
    constructor(
        @InjectRepository(OrganizationParametersModel)
        private readonly organizationParametersRepository: Repository<OrganizationParametersModel>,
    ) {}

    async find(filter?: Partial<IOrganizationParameters>): Promise<OrganizationParametersEntity[]> {
        try {
            const { organization, ...otherFilterAttributes } = filter || {};

            const teamCondition = createNestedConditions('organization', organization);

            const findOptions: FindManyOptions<OrganizationParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...teamCondition,
                },
            };

            const organizationParametersModel =
                await this.organizationParametersRepository.find(findOptions);

            return mapSimpleModelsToEntities(
                organizationParametersModel,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(filter?: Partial<IOrganizationParameters>): Promise<OrganizationParametersEntity> {
        try {
            const { organization, ...otherFilterAttributes } = filter || {};

            const organizationCondition = createNestedConditions('organization', organization);

            const findOptions: FindManyOptions<OrganizationParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...organizationCondition,
                },
            };

            const organizationParametersModel =
                await this.organizationParametersRepository.findOne(findOptions);

            return mapSimpleModelToEntity(
                organizationParametersModel,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findByOrganizationName(
        organizationName: string,
    ): Promise<OrganizationParametersEntity | undefined> {
        try {
            const response = await this.organizationParametersRepository
                .createQueryBuilder('organizationParameters')
                .leftJoinAndSelect('organizationParameters.integration', 'integration')
                .where('organizationParameters.configValue @> :item::jsonb', {
                    item: JSON.stringify({
                        organizationName: organizationName,
                    }),
                })
                .getOne();

            if (!response) {
                return null;
            }

            return mapSimpleModelToEntity(response, OrganizationParametersEntity);
        } catch (err) {
            console.log(err);
        }
    }

    async findById(uuid: string): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder =
                this.organizationParametersRepository.createQueryBuilder(
                    'organizationParameters',
                );

            const organizationParametersSelected = await queryBuilder
                .where('organizationParameters.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                organizationParametersSelected,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async create(integrationConfig: IOrganizationParameters): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder =
                this.organizationParametersRepository.createQueryBuilder(
                    'organizationParameters',
                );

            const integrationConfigModel =
                this.organizationParametersRepository.create(integrationConfig);

            const integrationConfigCreated = await queryBuilder
                .insert()
                .values(integrationConfigModel)
                .execute();

            if (integrationConfigCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<OrganizationParametersModel> = {
                    where: {
                        uuid: integrationConfigCreated.identifiers[0].uuid,
                    },
                };

                const integrationConfig =
                    await this.organizationParametersRepository.findOne(
                        findOneOptions,
                    );

                if (!integrationConfig) return undefined;

                return mapSimpleModelToEntity(
                    integrationConfig,
                    OrganizationParametersEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IOrganizationParameters>,
        data: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<OrganizationParametersModel> =
                this.organizationParametersRepository
                    .createQueryBuilder('organizationParameters')
                    .update(OrganizationParametersModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { organization, ...otherFilterAttributes } = filter || {};

                const organizationCondition = createNestedConditions('organization', organization);

                const findOptions: FindManyOptions<OrganizationParametersModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...organizationCondition,
                    },
                };

                const integrationConfig =
                    await this.organizationParametersRepository.findOne(findOptions);

                if (integrationConfig) {
                    return mapSimpleModelToEntity(
                        integrationConfig,
                        OrganizationParametersEntity,
                    );
                }
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }
    async delete(uuid: string): Promise<void> {
        try {
            await this.organizationParametersRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity> {
        const queryBuilder =
            this.organizationParametersRepository.createQueryBuilder('organizationParameters');

        const integrationConfigSelected = await queryBuilder
            .where('organizationParameters.configKey = :configKey', { configKey })
            .andWhere('organizationParameters.organization_id = :organizationId', {
                organizationId: organizationAndTeamData.organizationId,
            })
            .getOne();

        return mapSimpleModelToEntity(
            integrationConfigSelected,
            OrganizationParametersEntity,
        );
    }
}
