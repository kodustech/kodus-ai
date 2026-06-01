import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { ParametersModel } from './schemas/parameters.model';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IParametersRepository } from '@libs/organization/domain/parameters/contracts/parameters.repository.contracts';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { IParameters } from '@libs/organization/domain/parameters/interfaces/parameters.interface';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class ParametersRepository implements IParametersRepository {
    constructor(
        @InjectRepository(ParametersModel)
        private readonly parametersRepository: Repository<ParametersModel>,
    ) {}

    async find<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>[]> {
        const { team, ...otherFilterAttributes } = filter || {};

        const teamCondition = createNestedConditions('team', team);

        const findOptions: FindManyOptions<ParametersModel> = {
            where: {
                ...otherFilterAttributes,
                ...teamCondition,
            },
            relations: ['team'],
        };

        const integrationConfigModel =
            await this.parametersRepository.find(findOptions);

        return mapSimpleModelsToEntities(
            integrationConfigModel,
            ParametersEntity,
        );
    }

    async findOne<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>> {
        const { team, ...otherFilterAttributes } = filter || {};

        const teamCondition = createNestedConditions('team', team);

        const findOptions: FindOneOptions<ParametersModel> = {
            where: {
                ...otherFilterAttributes,
                ...teamCondition,
            },
            relations: ['team'],
            order: {
                createdAt: 'DESC',
            },
        };

        const integrationConfigModel =
            await this.parametersRepository.findOne(findOptions);

        return mapSimpleModelToEntity(integrationConfigModel, ParametersEntity);
    }

    async findByOrganizationName<K extends ParametersKey>(
        organizationName: string,
    ): Promise<ParametersEntity<K> | undefined> {
        const response = await this.parametersRepository
            .createQueryBuilder('parameters')
            .leftJoinAndSelect('parameters.integration', 'integration')
            .where('parameters.configValue @> :item::jsonb', {
                item: JSON.stringify({
                    organizationName: organizationName,
                }),
            })
            .andWhere('parameters.active = :active', { active: true })
            .getOne();

        if (!response) {
            return null;
        }

        return mapSimpleModelToEntity(response, ParametersEntity);
    }

    async findById<K extends ParametersKey>(
        uuid: string,
    ): Promise<ParametersEntity<K>> {
        const queryBuilder =
            this.parametersRepository.createQueryBuilder('parameters');

        const integrationConfigSelected = await queryBuilder
            .where('parameters.uuid = :uuid', { uuid })
            .getOne();

        return mapSimpleModelToEntity(
            integrationConfigSelected,
            ParametersEntity,
        );
    }

    async create<K extends ParametersKey>(
        integrationConfig: IParameters<K>,
    ): Promise<ParametersEntity<K>> {
        const queryBuilder =
            this.parametersRepository.createQueryBuilder('parameters');

        const integrationConfigModel =
            this.parametersRepository.create(integrationConfig);

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
                await this.parametersRepository.findOne(findOneOptions);

            if (!integrationConfig) return undefined;

            return mapSimpleModelToEntity(integrationConfig, ParametersEntity);
        }
    }

    async update<K extends ParametersKey>(
        filter: Partial<IParameters<K>>,
        data: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>> {
        const queryBuilder: UpdateQueryBuilder<ParametersModel> =
            this.parametersRepository
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
                await this.parametersRepository.findOne(findOptions);

            if (integrationConfig) {
                return mapSimpleModelToEntity(
                    integrationConfig,
                    ParametersEntity,
                );
            }
        }

        return undefined;
    }
    async delete(uuid: string): Promise<void> {
        await this.parametersRepository.delete(uuid);
    }

    async deleteByTeamId(teamId: string): Promise<void> {
        await this.parametersRepository.delete({
            team: { uuid: teamId },
        });
    }

    async findByKey<K extends ParametersKey>(
        configKey: K,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity<K>> {
        const queryBuilder =
            this.parametersRepository.createQueryBuilder('parameters');

        const parametersSelected = await queryBuilder
            .where('parameters.configKey = :configKey', { configKey })
            .andWhere('parameters.team_id = :teamId', {
                teamId: organizationAndTeamData.teamId,
            })
            .andWhere('parameters.active = :active', { active: true })
            .getOne();

        return mapSimpleModelToEntity(parametersSelected, ParametersEntity);
    }

    async createNewActiveVersion<K extends ParametersKey>(
        configKey: K,
        teamId: string,
        configValue: IParameters<K>['configValue'],
        nextVersion: number,
    ): Promise<ParametersEntity<K> | undefined> {
        return this.parametersRepository.manager.transaction(
            async (manager) => {
                // Bulk-deactivate every currently-active row for this
                // (teamId, configKey) — not just the single row the caller
                // read. If a previous race left an orphan active row behind,
                // it is swept here in the same atomic operation.
                await manager
                    .createQueryBuilder()
                    .update(ParametersModel)
                    .set({ active: false })
                    .where('team_id = :teamId', { teamId })
                    .andWhere('"configKey" = :configKey', { configKey })
                    .andWhere('active = :active', { active: true })
                    .execute();

                const newUuid = uuidv4();
                await manager
                    .createQueryBuilder()
                    .insert()
                    .into(ParametersModel)
                    .values({
                        uuid: newUuid,
                        configKey,
                        configValue,
                        team: { uuid: teamId } as never,
                        active: true,
                        version: nextVersion,
                    })
                    .execute();

                const created = await manager.findOne(ParametersModel, {
                    where: { uuid: newUuid },
                });
                if (!created) return undefined;
                return mapSimpleModelToEntity(created, ParametersEntity);
            },
        );
    }
}
