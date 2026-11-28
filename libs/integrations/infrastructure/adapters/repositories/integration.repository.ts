import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    FindOptionsOrder,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';

import {
    IntegrationCategory,
    IntegrationConfigKey,
    PlatformType,
} from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import {
    IIntegrationRepository,
    SaveCodeManagementAuthOptions,
} from '@libs/integrations/domain/integrations/contracts/integration.repository.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { IIntegration } from '@libs/integrations/domain/integrations/interfaces/integration.interface';

import { AuthIntegrationModel } from './schemas/authIntegration.model';
import { IntegrationModel } from './schemas/integration.model';

// Setups that raced before the team lock left duplicate pairs behind. Before
// reads had an order, Postgres returned the lowest id, and the team's
// repository selection was saved against that pair. Reads and setup keep
// picking it (active first), so those teams stay ready for reviews.
const FIRST_ACTIVE: FindOptionsOrder<IntegrationModel> = {
    status: 'DESC',
    uuid: 'ASC',
};

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
                order: FIRST_ACTIVE,
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

    async saveCodeManagementAuth(
        { organizationId, teamId }: OrganizationAndTeamData,
        platform: PlatformType,
        authDetails: Record<string, unknown>,
        options: SaveCodeManagementAuthOptions = {},
    ): Promise<IntegrationEntity> {
        return this.integrationRepository.manager.transaction(
            async (manager) => {
                // The team exists before its first integration. Lock it before
                // looking up the pair so simultaneous setups reuse the same rows.
                const teamRows = await manager.query(
                    'SELECT 1 FROM teams WHERE uuid = $1 AND organization_id = $2 FOR NO KEY UPDATE',
                    [teamId, organizationId],
                );
                if (!teamRows.length)
                    throw new Error('Integration team not found.');

                const organization = { uuid: organizationId };
                const team = { uuid: teamId };
                const existing = await manager.findOne(IntegrationModel, {
                    where: { organization, team, platform },
                    relations: { authIntegration: true },
                    order: FIRST_ACTIVE,
                });
                const previous = existing?.authIntegration?.authDetails;
                if (previous && options.resetsSelection?.(previous)) {
                    await manager.query(
                        'DELETE FROM integration_configs WHERE team_id = $1 AND "configKey" = $2',
                        [teamId, IntegrationConfigKey.REPOSITORIES],
                    );
                }
                const authIntegration = await manager.save(
                    AuthIntegrationModel,
                    {
                        uuid: existing?.authIntegration?.uuid,
                        organization,
                        team,
                        status: true,
                        authDetails,
                    },
                );
                const integration = await manager.save(IntegrationModel, {
                    uuid: existing?.uuid,
                    platform,
                    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                    organization,
                    team,
                    status: true,
                    authIntegration: { uuid: authIntegration.uuid },
                });
                return IntegrationEntity.create(integration);
            },
        );
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
            // Swallowing this error leaves a stale active integration behind
            // (e.g. when a remaining integration_config still references it),
            // which breaks reconnecting the provider later.
            throw error;
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
                    } as any,
                    team: {
                        uuid: organizationAndTeamData?.teamId,
                    } as any,
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
