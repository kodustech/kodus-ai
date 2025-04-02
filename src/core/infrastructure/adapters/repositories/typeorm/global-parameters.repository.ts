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
import { GlobalParametersModel } from './schema/global-parameters.model';
import { GlobalParametersEntity } from '@/core/domain/global-parameters/entities/global-parameters.entity';
import { IGlobalParameters } from '@/core/domain/global-parameters/interfaces/global-parameters.interface';
import { IGlobalParametersRepository } from '@/core/domain/global-parameters/contracts/global-parameters.repository.contracts';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';

@Injectable()
export class GlobalParametersRepository implements IGlobalParametersRepository {
    constructor(
        @InjectRepository(GlobalParametersModel)
        private readonly globalParametersRepository: Repository<GlobalParametersModel>,
    ) {}

    async find(
        filter?: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity[]> {
        try {
            const findOptions: FindManyOptions<GlobalParametersModel> = {
                where: filter,
            };

            const globalParametersModel =
                await this.globalParametersRepository.find(findOptions);

            return mapSimpleModelsToEntities(
                globalParametersModel,
                GlobalParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async findOne(
        filter?: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity> {
        try {
            const findOptions: FindManyOptions<GlobalParametersModel> = {
                where: filter,
            };

            const globalParametersModel =
                await this.globalParametersRepository.findOne(findOptions);

            return mapSimpleModelToEntity(
                globalParametersModel,
                GlobalParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async findById(uuid: string): Promise<GlobalParametersEntity> {
        try {
            const queryBuilder =
                this.globalParametersRepository.createQueryBuilder(
                    'global_parameters',
                );

            const globalParametersSelected = await queryBuilder
                .where('global_parameters.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                globalParametersSelected,
                GlobalParametersEntity,
            );
        } catch (error) {
            throw error;
        }
    }

    async create(
        globalParameter: IGlobalParameters,
    ): Promise<GlobalParametersEntity> {
        try {
            const queryBuilder =
                this.globalParametersRepository.createQueryBuilder(
                    'global_parameters',
                );

            const globalParametersModel =
                this.globalParametersRepository.create(globalParameter);

            const globalParametersCreated = await queryBuilder
                .insert()
                .values(globalParametersModel)
                .execute();

            if (globalParametersCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<GlobalParametersModel> = {
                    where: {
                        uuid: globalParametersCreated.identifiers[0].uuid,
                    },
                };

                const globalParameters =
                    await this.globalParametersRepository.findOne(
                        findOneOptions,
                    );

                if (!globalParameters) return undefined;

                return mapSimpleModelToEntity(
                    globalParameters,
                    GlobalParametersEntity,
                );
            }
        } catch (error) {
            throw error;
        }
    }

    async update(
        filter: Partial<IGlobalParameters>,
        data: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<GlobalParametersModel> =
                this.globalParametersRepository
                    .createQueryBuilder('global_parameters')
                    .update(GlobalParametersModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const findOptions: FindManyOptions<GlobalParametersModel> = {
                    where: filter,
                };

                const globalParameters =
                    await this.globalParametersRepository.findOne(findOptions);

                if (globalParameters) {
                    return mapSimpleModelToEntity(
                        globalParameters,
                        GlobalParametersEntity,
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
            await this.globalParametersRepository.delete(uuid);
        } catch (error) {
            throw error;
        }
    }

    async findByKey(
        configKey: GlobalParametersKey,
    ): Promise<GlobalParametersEntity> {
        const queryBuilder =
            this.globalParametersRepository.createQueryBuilder(
                'global_parameters',
            );

        const globalParametersSelected = await queryBuilder
            .where('global_parameters.configKey = :configKey', { configKey })
            .getOne();

        return mapSimpleModelToEntity(
            globalParametersSelected,
            GlobalParametersEntity,
        );
    }
}
