import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AuthIntegrationModel } from './schema/authIntegration.model';
import { FindManyOptions, Raw, Repository, UpdateQueryBuilder } from 'typeorm';
import { IAuthIntegrationRepository } from '@/core/domain/authIntegrations/contracts/auth-integration.repository.contracts';
import { AuthIntegrationEntity } from '@/core/domain/authIntegrations/entities/auth-integration.entity';
import { IAuthIntegration } from '@/core/domain/authIntegrations/interfaces/auth-integration.interface';
import { mapSimpleModelToEntity } from '@/shared/infrastructure/repositories/mappers';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

@Injectable()
export class AuthIntegrationRepository implements IAuthIntegrationRepository {
    constructor(
        @InjectRepository(AuthIntegrationModel)
        private readonly authIntegrationRepository: Repository<AuthIntegrationModel>,
    ) {}

    async findOne(
        filter?: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity> {
        try {
            // Destructuring with existence check
            const {
                organization,
                team,
                integration,
                authDetails,
                ...otherFilterAttributes
            } = filter || {};

            const findOptions: FindManyOptions<AuthIntegrationModel> = {
                where: { ...otherFilterAttributes },
                relations: [
                    'organization',
                    'organization.teams',
                    'integration',
                ],
            };

            // Adds organization condition, if defined
            if (organization) {
                findOptions.where = {
                    ...findOptions.where,
                    ...createNestedConditions('organization', organization),
                };
            }

            if (team) {
                findOptions.where = {
                    ...findOptions.where,
                    ...createNestedConditions('team', team),
                };
            }

            if (integration) {
                findOptions.where = {
                    ...findOptions.where,
                    ...createNestedConditions('integration', integration),
                };
            }

            if (authDetails && Object.keys(authDetails).length > 0) {
                // Adds conditions for authDetails, if defined
                findOptions.where = {
                    ...findOptions.where,
                    authDetails: Raw((alias) => `${alias} @> :authDetails`, {
                        authDetails: JSON.stringify(authDetails),
                    }),
                };
            }

            // Executes the query with the search options
            const authIntegrationSelected =
                await this.authIntegrationRepository.findOne(findOptions);

            if (!authIntegrationSelected) return undefined;

            return mapSimpleModelToEntity(
                authIntegrationSelected,
                AuthIntegrationEntity,
            );
        } catch (error) {
            console.error('Error while fetching AuthIntegration:', error);
            throw error;
        }
    }

    async find(
        filter?: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity[]> {
        try {
            const {
                organization,
                team,
                integration,
                ...otherFilterAttributes
            } = filter || {};

            const organizationCondition = createNestedConditions(
                'organization',
                organization,
            );

            const teamCondition = createNestedConditions('team', team);

            const integrationCondition = createNestedConditions(
                'integration',
                integration,
            );

            const findOptions: FindManyOptions<AuthIntegrationModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...organizationCondition,
                    ...teamCondition,
                    ...integrationCondition,
                },
            };

            const authIntegrations =
                await this.authIntegrationRepository.find(findOptions);

            return mapSimpleModelToEntity(
                authIntegrations,
                AuthIntegrationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<AuthIntegrationEntity> {
        try {
            const authIntegration =
                await this.authIntegrationRepository.findOneBy({ uuid });

            return mapSimpleModelToEntity(
                authIntegration,
                AuthIntegrationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async create(
        authIntegrationData: IAuthIntegration,
    ): Promise<AuthIntegrationEntity> {
        try {
            const authIntegration =
                this.authIntegrationRepository.create(authIntegrationData);

            const savedAuthIntegration =
                await this.authIntegrationRepository.save(authIntegration);

            return mapSimpleModelToEntity(
                savedAuthIntegration,
                AuthIntegrationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IAuthIntegration>,
        data: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<AuthIntegrationModel> =
                this.authIntegrationRepository
                    .createQueryBuilder('auth_integrations')
                    .update(AuthIntegrationModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const {
                    organization,
                    team,
                    integration,
                    ...otherFilterAttributes
                } = filter || {};

                if (!organization?.uuid) {
                    return undefined;
                }

                const organizationCondition = createNestedConditions(
                    'organization',
                    organization,
                );

                const teamCondition = createNestedConditions('team', team);

                const integrationCondition = createNestedConditions(
                    'integration',
                    integration,
                );

                const findOptions: FindManyOptions<AuthIntegrationModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...organizationCondition,
                        ...teamCondition,
                        ...integrationCondition,
                    },
                };

                const authIntegration =
                    await this.authIntegrationRepository.findOne(findOptions);

                if (!authIntegration) return undefined;

                if (authIntegration) {
                    return mapSimpleModelToEntity(
                        authIntegration,
                        AuthIntegrationEntity,
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
            await this.authIntegrationRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async getIntegrationUuidByAuthDetails(
        authDetails: any,
        platformType: PlatformType,
    ): Promise<string | undefined> {
        try {
            const findOptions: FindManyOptions<AuthIntegrationModel> = {
                relations: ['integration'],
                where: {
                    authDetails: Raw((alias) => `${alias} @> :authDetails`, {
                        authDetails: JSON.stringify(authDetails),
                    }),
                    integration: {
                        platform: platformType,
                    },
                },
            };

            // Execute the query with the search options
            const authIntegrationSelected =
                await this.authIntegrationRepository.findOne(findOptions);

            if (!authIntegrationSelected) {
                return undefined;
            }

            // Return the `uuid` of the `IntegrationModel`
            return authIntegrationSelected.integration?.uuid;
        } catch (error) {
            console.error('Error while fetching AuthIntegration:', error);
            throw error;
        }
    }
}
