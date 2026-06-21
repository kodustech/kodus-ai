import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    Raw,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';

import { IntegrationConfigKey, PlatformType } from '@libs/core/domain/enums';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import { IIntegrationConfigRepository } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.repository.contracts';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { IIntegrationConfig } from '@libs/integrations/domain/integrationConfigs/interfaces/integration-config.interface';

import { IntegrationConfigModel } from './schemas/integrationConfig.model';

@Injectable()
export class IntegrationConfigRepository implements IIntegrationConfigRepository {
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

            // Para integration, use objeto aninhado (TypeORM espera assim para campos primitivos do relacionamento)
            const where: any = {
                ...otherFilterAttributes,
                ...(integration ? { integration: integration as any } : {}),
                ...createNestedConditions('team', team),
            };

            const findOptions: FindManyOptions<IntegrationConfigModel> = {
                where,
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
        platform: PlatformType,
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
                    integration: {
                        platform,
                        status: true,
                    },
                },
                relations: [
                    'integration',
                    'integration.authIntegration',
                    'team',
                    'team.organization',
                ],
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
                            } as any,
                        } as any,
                        team: { uuid: organizationAndTeamData.teamId } as any,
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
            // Surface the failure so the integration delete that depends on
            // these rows being gone doesn't proceed against a stale config.
            throw error;
        }
    }
}
