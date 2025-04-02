import { IIntegrationConfigRepository } from '@/core/domain/integrationConfigs/contracts/integration-config.repository.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { IIntegrationConfig } from '@/core/domain/integrationConfigs/interfaces/integration-config.interface';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IntegrationConfigModel } from './schema/integrationConfig.model';
import {
    FindManyOptions,
    FindOneOptions,
    Raw,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class IntegrationConfigRepository
    implements IIntegrationConfigRepository
{
    constructor(
        @InjectRepository(IntegrationConfigModel)
        private readonly integrationConfigRepository: Repository<IntegrationConfigModel>,
    ) {}

    async savePrivateChannel(params: {
        integrationId: string;
        channelId: string;
        isConfirmed: boolean;
        organizationId: string;
        teamId: string;
    }): Promise<void> {
        try {
            const { integrationId, isConfirmed, channelId } = params;

            const integrationConfig = await this.findOne({
                configKey: IntegrationConfigKey.CHANNEL_INFO,
                configValue: { channelId },
                integration: { uuid: integrationId },
                team: { uuid: params.teamId },
            });

            await this.integrationConfigRepository
                .createQueryBuilder()
                .update(integrationConfig)
                .set({
                    configValue: () =>
                        `jsonb_set(configValue, '{isConfirmed}', '${JSON.stringify(isConfirmed)}', true)`,
                })
                .where(
                    "configKey = :key and integration_id = :uuid and configValue ->> 'channelId' = :channelId",
                    {
                        key: IntegrationConfigKey.CHANNEL_INFO,
                        uuid: integrationId,
                        channelId: channelId,
                    },
                )
                .execute();
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity[]> {
        try {
            const { integration, team, ...otherFilterAttributes } =
                filter || {};

            const integrationCondition = createNestedConditions(
                'integration',
                integration,
            );

            const teamCondition = createNestedConditions('team', team);

            const findOptions: FindManyOptions<IntegrationConfigModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...integrationCondition,
                    ...teamCondition,
                },
                relations: ['integration', 'integration.organization', 'team'],
            };

            const integrationConfigModel =
                await this.integrationConfigRepository.find(findOptions);

            return mapSimpleModelsToEntities(
                integrationConfigModel,
                IntegrationConfigEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        try {
            const { integration, team, configValue, ...otherFilterAttributes } =
                filter || {};

            const integrationCondition = createNestedConditions(
                'integration',
                integration,
            );

            const teamCondition = createNestedConditions('team', team);

            const findOptions: FindManyOptions<IntegrationConfigModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...integrationCondition,
                    ...teamCondition,
                },
                relations: ['integration', 'integration.organization', 'team'],
            };

            if (configValue && Object.keys(configValue)?.length > 0) {
                findOptions.where = {
                    ...findOptions.where,
                    configValue: Raw((alias) => `${alias} @> :configValue`, {
                        configValue: JSON.stringify(configValue),
                    }),
                };
            }

            const integrationConfigModel =
                await this.integrationConfigRepository.findOne(findOptions);

            return mapSimpleModelToEntity(
                integrationConfigModel,
                IntegrationConfigEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findByOrganizationName(
        organizationName: string,
    ): Promise<IntegrationConfigEntity | undefined> {
        try {
            const response = await this.integrationConfigRepository
                .createQueryBuilder('integration_configs')
                .leftJoinAndSelect(
                    'integration_configs.integration',
                    'integration',
                )
                .where('integration_configs.configValue @> :item::jsonb', {
                    item: JSON.stringify({
                        organizationName: organizationName,
                    }),
                })
                .getOne();

            if (!response) {
                return null;
            }

            return mapSimpleModelToEntity(response, IntegrationConfigEntity);
        } catch (err) {
            console.log(err);
        }
    }

    async findByInstallId(
        installId: string,
    ): Promise<IntegrationConfigEntity | undefined> {
        try {
            const response = await this.integrationConfigRepository
                .createQueryBuilder('integration_configs')
                .where('integration_configs.configValue @> :item::jsonb', {
                    item: JSON.stringify({
                        installId: installId,
                    }),
                })
                .getOne();

            if (!response) {
                return null;
            }

            return mapSimpleModelToEntity(response, IntegrationConfigEntity);
        } catch (err) {
            console.log(err);
        }
    }

    async findById(uuid: string): Promise<IntegrationConfigEntity> {
        try {
            const queryBuilder =
                this.integrationConfigRepository.createQueryBuilder(
                    'integration_configs',
                );

            const integrationConfigSelected = await queryBuilder
                .where('integration_configs.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                integrationConfigSelected,
                IntegrationConfigEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findIntegrationConfigWithTeams(
        configKey: IntegrationConfigKey,
        repositoryId: string,
    ): Promise<IntegrationConfigEntity[]> {
        try {
            const configs = await this.integrationConfigRepository.find({
                where: {
                    configKey,
                    configValue: Raw((alias) => `${alias} @> :configValue`, {
                        configValue: JSON.stringify([
                            { id: `${repositoryId}` },
                        ]),
                    }),
                    team: {
                        status: STATUS.ACTIVE,
                    },
                },
                relations: ['integration', 'team', 'team.organization'],
                order: {
                    updatedAt: 'DESC',
                },
            });

            return mapSimpleModelsToEntities(
                configs || [],
                IntegrationConfigEntity,
            );
        } catch (error) {
            console.log(error);
            return [];
        }
    }

    async create(
        integrationConfig: IIntegrationConfig,
    ): Promise<IntegrationConfigEntity> {
        try {
            const queryBuilder =
                this.integrationConfigRepository.createQueryBuilder(
                    'integration_configs',
                );

            const integrationConfigModel =
                this.integrationConfigRepository.create(integrationConfig);

            const integrationConfigCreated = await queryBuilder
                .insert()
                .values(integrationConfigModel)
                .execute();

            if (integrationConfigCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<IntegrationConfigModel> = {
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
                    IntegrationConfigEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IIntegrationConfig>,
        data: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<IntegrationConfigModel> =
                this.integrationConfigRepository
                    .createQueryBuilder('integration_configs')
                    .update(IntegrationConfigModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { integration, team, ...otherFilterAttributes } =
                    filter || {};

                if (!integration?.uuid) return undefined;

                const integrationCondition = createNestedConditions(
                    'integration',
                    integration,
                );

                const teamCondition = createNestedConditions('team', team);

                const findOptions: FindManyOptions<IntegrationConfigModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...integrationCondition,
                        ...teamCondition,
                    },
                };

                const integrationConfig =
                    await this.integrationConfigRepository.findOne(findOptions);

                if (integrationConfig) {
                    return mapSimpleModelToEntity(
                        integrationConfig,
                        IntegrationConfigEntity,
                    );
                }
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async findOneIntegrationConfigWithIntegrations(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity> {
        try {
            if (!configKey || !organizationAndTeamData) return undefined;

            const integrationConfig =
                await this.integrationConfigRepository.findOne({
                    where: {
                        configKey: configKey,
                        integration: {
                            organization: {
                                uuid: organizationAndTeamData.organizationId,
                            },
                        },
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                    relations: [
                        'integration',
                        'integration.authIntegration',
                        'integration.organization',
                    ],
                    order: {
                        updatedAt: 'DESC',
                    },
                });

            if (!integrationConfig) return undefined;

            return mapSimpleModelToEntity(
                integrationConfig,
                IntegrationConfigEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.integrationConfigRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }
}
