import { IIntegrationRepository } from '@/core/domain/integrations/contracts/integration.repository.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { IIntegration } from '@/core/domain/integrations/interfaces/integration.interface';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IntegrationModel } from './schema/integration.model';
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
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class IntegrationRepository implements IIntegrationRepository {
    constructor(
        @InjectRepository(IntegrationModel)
        private readonly integrationRepository: Repository<IntegrationModel>,
    ) {}

    async find(filter?: Partial<IIntegration>): Promise<IntegrationEntity[]> {
        try {
            const {
                organization,
                team,
                authIntegration,
                integrationConfigs,
                ...otherFilterAttributes
            } = filter || {};

            const organizationCondition = createNestedConditions(
                'organization',
                organization,
            );

            const teamCondition = createNestedConditions('team', team);

            const authIntegrationCondition = createNestedConditions(
                'authIntegration',
                authIntegration,
            );

            const integrationConfigsCondition = createNestedConditions(
                'integrationConfigs',
                integrationConfigs,
            );

            const findOptions: FindManyOptions<IntegrationModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...integrationConfigsCondition,
                    ...organizationCondition,
                    ...teamCondition,
                    ...authIntegrationCondition,
                },
                relations: ['authIntegration'],
            };

            const integration =
                await this.integrationRepository.find(findOptions);

            return mapSimpleModelsToEntities(integration, IntegrationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(filter?: Partial<IIntegration>): Promise<IntegrationEntity> {
        try {
            const {
                organization,
                team,
                authIntegration,
                integrationConfigs,
                ...otherFilterAttributes
            } = filter || {};

            if (!filter?.organization?.uuid) return undefined;

            const organizationCondition = createNestedConditions(
                'organization',
                organization,
            );

            const teamCondition = createNestedConditions('team', team);

            const authIntegrationCondition = createNestedConditions(
                'authIntegration',
                authIntegration,
            );

            const integrationConfigsCondition = createNestedConditions(
                'integrationConfigs',
                integrationConfigs,
            );

            const findOptions: FindManyOptions<IntegrationModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...integrationConfigsCondition,
                    ...organizationCondition,
                    ...teamCondition,
                    ...authIntegrationCondition,
                },
                relations: ['authIntegration'],
            };

            const integration =
                await this.integrationRepository.findOne(findOptions);

            return mapSimpleModelToEntity(integration, IntegrationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<IntegrationEntity> {
        try {
            const queryBuilder =
                this.integrationRepository.createQueryBuilder('integrations');

            const integrationSelected = await queryBuilder
                .leftJoinAndSelect('integrations.organization', 'organization')
                .where('integrations.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                integrationSelected,
                IntegrationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async create(integration: IIntegration): Promise<IntegrationEntity> {
        try {
            const queryBuilder =
                this.integrationRepository.createQueryBuilder('integrations');

            const integrationModel =
                this.integrationRepository.create(integration);

            const integrationCreated = await queryBuilder
                .insert()
                .values(integrationModel)
                .execute();

            if (integrationCreated) {
                if (!integrationCreated?.identifiers[0]?.uuid) return undefined;

                const findOneOptions: FindOneOptions<IntegrationModel> = {
                    where: {
                        uuid: integrationCreated.identifiers[0].uuid,
                    },
                };

                const integrationExecution =
                    await this.integrationRepository.findOne(findOneOptions);

                if (!integrationExecution) return undefined;

                return mapSimpleModelToEntity(
                    integrationExecution,
                    IntegrationEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IIntegration>,
        data: Partial<IIntegration>,
    ): Promise<IntegrationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<IntegrationModel> =
                this.integrationRepository
                    .createQueryBuilder('integrations')
                    .update(IntegrationModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const {
                    organization,
                    team,
                    authIntegration,
                    integrationConfigs,
                    ...otherFilterAttributes
                } = filter || {};

                if (!organization?.uuid || !authIntegration?.uuid)
                    return undefined;

                const organizationCondition = createNestedConditions(
                    'organization',
                    organization,
                );

                const teamCondition = createNestedConditions('team', team);

                const authIntegrationCondition = createNestedConditions(
                    'authIntegration',
                    authIntegration,
                );

                const integrationConfigsCondition = createNestedConditions(
                    'integrationConfigs',
                    integrationConfigs,
                );

                const findOptions: FindManyOptions<IntegrationModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...integrationConfigsCondition,
                        ...organizationCondition,
                        ...teamCondition,
                        ...authIntegrationCondition,
                    },
                };

                const integration =
                    await this.integrationRepository.findOne(findOptions);

                if (integration) {
                    return mapSimpleModelToEntity(
                        integration,
                        IntegrationEntity,
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
            await this.integrationRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async getFullIntegrationDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<IntegrationEntity> {
        try {
            if (!organizationAndTeamData?.organizationId) {
                return undefined;
            }

            const integration = await this.integrationRepository.findOne({
                where: {
                    organization: {
                        uuid: organizationAndTeamData?.organizationId,
                    },
                    team: {
                        uuid: organizationAndTeamData?.teamId,
                    },
                    platform: platform,
                },
                relations: ['authIntegration', 'integrationConfigs'],
                order: {
                    updatedAt: 'DESC',
                },
            });

            if (!integration) {
                throw new Error('Integration not found.');
            }

            return mapSimpleModelToEntity(integration, IntegrationEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
