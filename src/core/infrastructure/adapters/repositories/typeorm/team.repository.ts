import { ITeamRepository } from '@/core/domain/team/contracts/team.repository.contract';
import { TeamEntity } from '@/core/domain/team/entities/team.entity';
import {
    IntegrationMatchType,
    IntegrationStatusFilter,
    ITeam,
    ITeamWithIntegrations,
    TeamsFilter,
} from '@/core/domain/team/interfaces/team.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    In,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import { TeamModel } from './schema/team.model';
import { createNestedConditions } from '@/shared/infrastructure/repositories/filters';
import { STATUS } from '@/config/types/database/status.type';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationModel } from './schema/integration.model';

@Injectable()
export class TeamDatabaseRepository implements ITeamRepository {
    constructor(
        @InjectRepository(TeamModel)
        private readonly teamRepository: Repository<TeamModel>,

        @InjectRepository(IntegrationModel)
        private readonly integrationRepository: Repository<IntegrationModel>,
    ) {}

    async find(
        filter?: Omit<Partial<ITeam>, 'status'>,
        status?: STATUS[],
        options?: FindManyOptions<any>,
    ): Promise<TeamEntity[]> {
        try {
            const { organization, ...otherFilterAttributes }: any =
                filter || {};

            if (status && status.length > 0) {
                otherFilterAttributes.status = In(status);
            }

            const findManyOptions: FindManyOptions<TeamModel> = {
                where: {
                    ...otherFilterAttributes,
                    organization: organization
                        ? { uuid: organization.uuid }
                        : undefined,
                },
                relations: ['organization'],
                ...options,
            } as FindManyOptions<TeamModel>;

            const teamsModel = await this.teamRepository.find(findManyOptions);

            return mapSimpleModelsToEntities(teamsModel, TeamEntity);
        } catch (error) {
            console.log(error);
            throw new Error('Error finding teams');
        }
    }

    async findFirstCreatedTeam(organizationId: string): Promise<TeamEntity> {
        try {
            const findOneOptions: FindOneOptions<TeamModel> = {
                where: {
                    organization: {
                        uuid: organizationId,
                    },
                    status: In([STATUS.ACTIVE, STATUS.PENDING]),
                },
                relations: ['organization'],

                order: {
                    createdAt: 'ASC',
                },
            };

            const teamsSelected =
                await this.teamRepository.find(findOneOptions);

            let teamSelected: TeamModel;

            if (teamsSelected.length === 1) {
                teamSelected = teamsSelected[0];
            } else if (teamsSelected.length > 1) {
                teamSelected = teamsSelected.find(
                    (team) => team.status === STATUS.ACTIVE,
                );
            }

            return mapSimpleModelToEntity(teamSelected, TeamEntity);
        } catch (error) {
            console.log(error);
        }
    }

    public async findOne(filter: Partial<ITeam>): Promise<TeamEntity> {
        try {
            const { organization, ...otherFilterAttributes } = filter;

            const findOneOptions: FindOneOptions<TeamModel> = {
                where: {
                    ...otherFilterAttributes,
                },
                relations: ['organization'],
            };

            if (organization?.uuid) {
                findOneOptions.where = {
                    ...findOneOptions.where,
                    organization: {
                        uuid: organization.uuid,
                        status: true,
                    },
                };
            }

            const teamSelected =
                await this.teamRepository.findOne(findOneOptions);

            if (teamSelected) {
                return mapSimpleModelToEntity(teamSelected, TeamEntity);
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    public async findById(uuid: string): Promise<TeamEntity> {
        try {
            const findOneOptions: FindOneOptions<TeamModel> = {
                where: {
                    uuid,
                },
            };

            const teamSelected =
                await this.teamRepository.findOne(findOneOptions);

            return mapSimpleModelToEntity(teamSelected, TeamEntity);
        } catch (error) {
            console.log(error);
        }
    }

    public async findManyByIds(teamIds: string[]): Promise<TeamEntity[]> {
        try {
            const findManyOptions: FindManyOptions<TeamModel> = {
                where: {
                    uuid: In(teamIds),
                },
                relations: ['organization'],
            };

            const teams = await this.teamRepository.find(findManyOptions);

            return mapSimpleModelsToEntities(teams, TeamEntity);
        } catch (error) {
            console.log(error);
        }
    }

    //#region Teams with integrations
    public async findTeamsWithIntegrations(
        params: TeamsFilter,
    ): Promise<ITeamWithIntegrations[]> {
        const {
            organizationId,
            status,
            integrationCategories,
            integrationStatus,
            matchType = IntegrationMatchType.SOME,
        } = params;

        const query = this.teamRepository
            .createQueryBuilder('team')
            .leftJoinAndSelect('team.organization', 'organization');

        if (organizationId) {
            query.where('organization.uuid = :organizationId', {
                organizationId,
            });
        }

        if (status !== undefined) {
            query.andWhere('team.status = :status', { status });
        }

        const teamsModel = await query.getMany();
        const teams = teamsModel.map((team) => TeamEntity.create(team));

        if (!teams?.length) {
            return [];
        }

        const integrations = await this.integrationRepository
            .createQueryBuilder('integration')
            .leftJoinAndSelect('integration.integrationConfigs', 'configs')
            .leftJoinAndSelect('integration.team', 'team')
            .where('team.uuid IN (:...teamIds)', {
                teamIds: teams.map((team) => team.uuid),
            })
            .getMany();

        const result = teams.map((team) => {
            const teamIntegrations = integrations.filter(
                (integration) => integration.team?.uuid === team.uuid,
            );

            const hasIntegration = (category: IntegrationCategory) =>
                teamIntegrations.some(
                    (i) => i.integrationCategory === category,
                );

            const hasConfiguration = (category: IntegrationCategory) =>
                teamIntegrations.some(
                    (i) =>
                        i.integrationCategory === category &&
                        i.integrationConfigs?.length > 0,
                );

            const teamWithIntegrations: ITeamWithIntegrations = {
                ...team.toObject(),
                hasCodeManagement: hasIntegration(
                    IntegrationCategory.CODE_MANAGEMENT,
                ),
                hasProjectManagement: hasIntegration(
                    IntegrationCategory.PROJECT_MANAGEMENT,
                ),
                hasCommunication: hasIntegration(
                    IntegrationCategory.COMMUNICATION,
                ),
                isCodeManagementConfigured: hasConfiguration(
                    IntegrationCategory.CODE_MANAGEMENT,
                ),
                isProjectManagementConfigured: hasConfiguration(
                    IntegrationCategory.PROJECT_MANAGEMENT,
                ),
                isCommunicationConfigured: hasConfiguration(
                    IntegrationCategory.COMMUNICATION,
                ),
            };

            return teamWithIntegrations;
        });

        if (integrationCategories?.length) {
            return this.filterTeamsByIntegrations(
                result,
                integrationCategories,
                integrationStatus,
                matchType,
            );
        }

        return result;
    }

    private checkTeamIntegrationStatus(
        team: ITeamWithIntegrations,
        category: IntegrationCategory,
        integrationStatus: IntegrationStatusFilter,
    ): boolean {
        switch (category) {
            case IntegrationCategory.CODE_MANAGEMENT:
                return integrationStatus === IntegrationStatusFilter.CONFIGURED
                    ? team.isCodeManagementConfigured
                    : team.hasCodeManagement;
            case IntegrationCategory.PROJECT_MANAGEMENT:
                return integrationStatus === IntegrationStatusFilter.CONFIGURED
                    ? team.isProjectManagementConfigured
                    : team.hasProjectManagement;
            case IntegrationCategory.COMMUNICATION:
                return integrationStatus === IntegrationStatusFilter.CONFIGURED
                    ? team.isCommunicationConfigured
                    : team.hasCommunication;
        }
    }

    private filterTeamsByIntegrations(
        teams: ITeamWithIntegrations[],
        integrationCategories: IntegrationCategory[],
        integrationStatus: IntegrationStatusFilter,
        matchType: IntegrationMatchType = IntegrationMatchType.SOME,
    ): ITeamWithIntegrations[] {
        return teams.filter((team) => {
            const matcher =
                matchType === IntegrationMatchType.EVERY
                    ? Array.prototype.every
                    : Array.prototype.some;

            return matcher.call(integrationCategories, (category) =>
                this.checkTeamIntegrationStatus(
                    team,
                    category,
                    integrationStatus,
                ),
            );
        });
    }

    //#endregion

    public async create(teamEntity: ITeam): Promise<TeamEntity> {
        try {
            const queryBuilder = this.teamRepository.createQueryBuilder('team');

            const teamModel = this.teamRepository.create(teamEntity);
            const team = await queryBuilder
                .insert()
                .values(teamModel)
                .execute();

            if (team) {
                if (!team?.identifiers[0]?.uuid) {
                    return undefined;
                }

                const findOneOptions: FindOneOptions<TeamModel> = {
                    where: {
                        uuid: team.identifiers[0].uuid,
                    },
                };

                const insertedTeam =
                    await this.teamRepository.findOne(findOneOptions);

                if (insertedTeam) {
                    return mapSimpleModelToEntity(insertedTeam, TeamEntity);
                }
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ITeam>,
        data: Partial<ITeam>,
    ): Promise<TeamEntity> | undefined {
        try {
            const { organization, ...otherFilterAttributes } = filter || {};

            const queryBuilder: UpdateQueryBuilder<TeamModel> =
                this.teamRepository
                    .createQueryBuilder('user')
                    .update(TeamModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            const organizationCondition = createNestedConditions(
                'organization',
                organization,
            );

            if (result.affected > 0) {
                const findOneOptions: FindOneOptions<TeamModel> = {
                    where: {
                        ...otherFilterAttributes,
                        ...organizationCondition,
                    },
                };

                const updatedTeam =
                    await this.teamRepository.findOne(findOneOptions);

                return mapSimpleModelToEntity(updatedTeam, TeamEntity);
            }
        } catch (error) {
            console.log(error);
        }
    }

    public async deleteOne(uuid: string): Promise<void> {
        try {
            const result = await this.teamRepository.update(uuid, {
                status: STATUS.REMOVED,
            });

            if (result.affected === 0) {
                throw new Error('No matching team found or deletion failed');
            }
        } catch (error) {
            console.log(error);
        }
    }

    async getTeamsByUserId(
        userId: string,
        organizationId: string,
        status?: STATUS[],
        options?: FindManyOptions<any>,
    ): Promise<TeamEntity[]> {
        try {
            const queryBuilder = this.teamRepository
                .createQueryBuilder('team')
                .innerJoin(
                    'team.teamMember',
                    'teamMember',
                    'teamMember.user_id = :userId',
                    { userId },
                )
                .leftJoinAndSelect('team.organization', 'organization');

            if (organizationId) {
                queryBuilder.andWhere(
                    'team.organization_id = :organizationId',
                    { organizationId },
                );
            }

            if (status && status.length > 0) {
                queryBuilder.andWhere('team.status IN (:...status)', {
                    status,
                });
            }

            if (options?.order) {
                Object.keys(options.order).forEach((key) => {
                    const orderDirection = options.order[key] as 'ASC' | 'DESC';
                    queryBuilder.addOrderBy(`team.${key}`, orderDirection);
                });
            }

            const teamsModel = await queryBuilder.getMany();

            return mapSimpleModelsToEntities(teamsModel, TeamEntity);
        } catch (error) {
            console.log(error);
            throw new Error('Error finding teams by user ID');
        }
    }
}
