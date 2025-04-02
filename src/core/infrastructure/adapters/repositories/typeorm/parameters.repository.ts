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
import { ParametersModel } from './schema/parameters.model';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { IParameters } from '@/core/domain/parameters/interfaces/parameters.interface';
import { IParametersRepository } from '@/core/domain/parameters/contracts/parameters.repository.contracts';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class ParametersRepository implements IParametersRepository {
    constructor(
        @InjectRepository(ParametersModel)
        private readonly integrationConfigRepository: Repository<ParametersModel>,
    ) {}

    async find(filter?: Partial<IParameters>): Promise<ParametersEntity[]> {
        try {
            const { team, ...otherFilterAttributes } = filter || {};

            const teamCondition = createNestedConditions('team', team);

            const findOptions: FindManyOptions<ParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...teamCondition,
                },
            };

            const integrationConfigModel =
                await this.integrationConfigRepository.find(findOptions);

            return mapSimpleModelsToEntities(
                integrationConfigModel,
                ParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async findOne(filter?: Partial<IParameters>): Promise<ParametersEntity> {
        try {
            const { team, ...otherFilterAttributes } = filter || {};

            const teamCondition = createNestedConditions('team', team);

            const findOptions: FindManyOptions<ParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...teamCondition,
                },
            };

            const integrationConfigModel =
                await this.integrationConfigRepository.findOne(findOptions);

            return mapSimpleModelToEntity(
                integrationConfigModel,
                ParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async findByOrganizationName(
        organizationName: string,
    ): Promise<ParametersEntity | undefined> {
        try {
            const response = await this.integrationConfigRepository
                .createQueryBuilder('parameters')
                .leftJoinAndSelect('parameters.integration', 'integration')
                .where('parameters.configValue @> :item::jsonb', {
                    item: JSON.stringify({
                        organizationName: organizationName,
                    }),
                })
                .getOne();

            if (!response) {
                return null;
            }

            return mapSimpleModelToEntity(response, ParametersEntity);
        } catch (err) {
            throw err;
        }
    }

    async findById(uuid: string): Promise<ParametersEntity> {
        try {
            const queryBuilder =
                this.integrationConfigRepository.createQueryBuilder(
                    'parameters',
                );

            const integrationConfigSelected = await queryBuilder
                .where('parameters.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                integrationConfigSelected,
                ParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async create(integrationConfig: IParameters): Promise<ParametersEntity> {
        try {
            const queryBuilder =
                this.integrationConfigRepository.createQueryBuilder(
                    'parameters',
                );

            const integrationConfigModel =
                this.integrationConfigRepository.create(integrationConfig);

            const integrationConfigCreated = await queryBuilder
                .insert()
                .values(integrationConfigModel)
                .execute();

            if (integrationConfigCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<ParametersModel> = {
                    where: {
                        uuid: integrationConfigCreated.identifiers[0].uuid,
                    },
                };

                const integrationConfig =
                    await this.integrationConfigRepository.findOne(
                        findOneOptions,
                    );

                if (!integrationConfig) return undefined;

                return mapSimpleModelToEntity(
                    integrationConfig,
                    ParametersEntity,
                );
            }
        } catch (error) {
            throw error;
        }
    }

    async update(
        filter: Partial<IParameters>,
        data: Partial<IParameters>,
    ): Promise<ParametersEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<ParametersModel> =
                this.integrationConfigRepository
                    .createQueryBuilder('parameters')
                    .update(ParametersModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { team, ...otherFilterAttributes } = filter || {};

                const teamCondition = createNestedConditions('team', team);

                const findOptions: FindManyOptions<ParametersModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...teamCondition,
                    },
                };

                const integrationConfig =
                    await this.integrationConfigRepository.findOne(findOptions);

                if (integrationConfig) {
                    return mapSimpleModelToEntity(
                        integrationConfig,
                        ParametersEntity,
                    );
                }
            }

            return undefined;
        } catch (error) {
            throw error;
        }
    }
    async delete(uuid: string): Promise<void> {
        try {
            await this.integrationConfigRepository.delete(uuid);
        } catch (error) {
            throw error;
        }
    }

    async findByKey(
        configKey: ParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity> {
        const queryBuilder =
            this.integrationConfigRepository.createQueryBuilder('parameters');

        const integrationConfigSelected = await queryBuilder
            .where('parameters.configKey = :configKey', { configKey })
            .andWhere('parameters.team_id = :teamId', {
                teamId: organizationAndTeamData.teamId,
            })
            .getOne();

        return mapSimpleModelToEntity(
            integrationConfigSelected,
            ParametersEntity,
        );
    }
}
