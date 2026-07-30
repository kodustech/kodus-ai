import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createLogger } from '@libs/core/log/logger';
import { FindOneOptions, Repository, UpdateQueryBuilder } from 'typeorm';
import { In } from 'typeorm';

import { TeamMemberModel } from './schemas/teamMember.model';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ITeamMemberRepository } from '@libs/organization/domain/teamMembers/contracts/teamMembers.repository.contracts';
import { TeamMemberEntity } from '@libs/organization/domain/teamMembers/entities/teamMember.entity';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';
import {
    IMembers,
    ITeamMember,
} from '@libs/organization/domain/teamMembers/interfaces/teamMembers.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class TeamMemberDatabaseRepository implements ITeamMemberRepository {
    private readonly logger = createLogger(TeamMemberDatabaseRepository.name);

    constructor(
        @InjectRepository(TeamMemberModel)
        private readonly teamMembersRepository: Repository<TeamMemberModel>,
    ) {}

    //#region Find
    public async findOne(
        filter: Partial<ITeamMember>,
    ): Promise<TeamMemberEntity> {
        try {
            const { organization, ...otherFilterAttributes } = filter;

            const findOneOptions: FindOneOptions<TeamMemberModel> = {
                where: {
                    ...otherFilterAttributes,
                    user: filter.user ? { uuid: filter.user.uuid } : undefined,
                    organization: filter.organization
                        ? { uuid: filter.organization.uuid }
                        : undefined,
                    team: filter.team ? { uuid: filter.team.uuid } : undefined,
                },
                relations: ['team', 'user'],
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

            const teamMemberSelected =
                await this.teamMembersRepository.findOne(findOneOptions);

            if (teamMemberSelected) {
                return mapSimpleModelToEntity(
                    teamMemberSelected,
                    TeamMemberEntity,
                );
            }

            return undefined;
        } catch (error) {
            this.logger.error({
                message: 'Error finding team member',
                context: TeamMemberDatabaseRepository.name,
                error,
            });
        }
    }

    async findById(uuid: string): Promise<TeamMemberEntity> {
        try {
            const data = await this.teamMembersRepository.findOne({
                where: {
                    uuid: uuid,
                },
            });

            return mapSimpleModelToEntity(data, TeamMemberEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error finding team member by id',
                context: TeamMemberDatabaseRepository.name,
                error,
            });
            return null;
        }
    }

    async findManyById(ids: string[]): Promise<TeamMemberEntity[]> {
        try {
            const data = await this.teamMembersRepository.find({
                where: { uuid: In(ids) },
                relations: ['user', 'team'],
            });

            return mapSimpleModelsToEntities(data, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error finding many team members by id',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return [];
        }
    }

    async findManyByUser(
        userId: string,
        teamMemberStatus: boolean,
    ): Promise<TeamMemberEntity[]> {
        try {
            const data = await this.teamMembersRepository.find({
                where: { user: { uuid: userId }, status: teamMemberStatus },
                relations: ['team'],
            });

            return mapSimpleModelsToEntities(data, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error finding many team members by user',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return [];
        }
    }

    async findManyByOrganizationId(
        organizationId: string,
        teamStatus: STATUS[],
    ): Promise<TeamMemberEntity[]> {
        try {
            const whereCondition: any = {
                organization: {
                    uuid: organizationId,
                    status: true,
                },
                team: {},
            };

            if (teamStatus && teamStatus.length > 0) {
                whereCondition.team.status = In(teamStatus);
            }

            const data = await this.teamMembersRepository.find({
                where: whereCondition,
                relations: ['user', 'team'],
            });

            return mapSimpleModelsToEntities(data, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error finding many team members by organization id',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return [];
        }
    }

    async findMembersByCommunicationId(
        communicationId: string,
    ): Promise<TeamMemberModel[] | null> {
        try {
            if (!communicationId) {
                return null;
            }

            const query = this.teamMembersRepository
                .createQueryBuilder('team_member')
                .select(['team_member', 'team.uuid', 'organization.uuid'])
                .leftJoin('team_member.team', 'team')
                .leftJoin('team_member.organization', 'organization')
                .where(
                    'team_member.communicationId = :communicationId AND team.status = :teamStatus',
                    {
                        communicationId,
                        teamStatus: STATUS.ACTIVE,
                    },
                )
                .andWhere('team_member.status = :status', { status: true });

            return await query.getMany();
        } catch (err) {
            this.logger.error({
                message: 'Error finding team members by communication id',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return null;
        }
    }

    async findManyByRelations(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]> {
        try {
            const data = await this.teamMembersRepository.find({
                where: {
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    team: { uuid: organizationAndTeamData.teamId },
                },
                relations: ['user', 'team'],
            });

            return mapSimpleModelsToEntities(data, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error finding many team members by relations',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return [];
        }
    }

    async findTeamMembersWithUser(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<TeamMemberEntity[]> {
        try {
            const data = await this.teamMembersRepository.find({
                where: {
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    team: { uuid: organizationAndTeamData.teamId },
                    ...(teamMembersStatus !== undefined
                        ? { status: teamMembersStatus }
                        : {}),
                },
                relations: ['user'],
            });

            return mapSimpleModelsToEntities(data, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error finding team members with user',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return [];
        }
    }
    //#endregion

    //#region Count
    async countTeamMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        try {
            const membersCount = await this.teamMembersRepository
                .createQueryBuilder('team_member')
                .leftJoin('team_member.user', 'user')
                .where('team_member.organization_id = :orgId', {
                    orgId: organizationAndTeamData.organizationId,
                })
                .andWhere('team_member.team_id = :teamId', {
                    teamId: organizationAndTeamData.teamId,
                })
                .andWhere('teamRole = :role', { role: TeamMemberRole.MEMBER })
                .getCount();

            return membersCount;
        } catch (err) {
            this.logger.error({
                message: 'Error counting team members',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return 0;
        }
    }

    async countByUser(
        userId: string,
        teamMemberStatus?: boolean,
    ): Promise<number> {
        const count = await this.teamMembersRepository.count({
            where: { user: { uuid: userId }, status: teamMemberStatus },
        });

        return count;
    }
    //#endregion

    //#region CRUD
    async create(teamMember: ITeamMember): Promise<any> {
        try {
            const teamMembersModel =
                this.teamMembersRepository.create(teamMember);

            const savedTeamMembers =
                await this.teamMembersRepository.save(teamMembersModel);

            return mapSimpleModelToEntity(savedTeamMembers, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error creating team member',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return err;
        }
    }

    async update(
        filter: Partial<ITeamMember>,
        teamMember: Partial<ITeamMember>,
    ): Promise<any> {
        try {
            const queryBuilder: UpdateQueryBuilder<TeamMemberModel> =
                this.teamMembersRepository
                    .createQueryBuilder('team_member')
                    .update(TeamMemberModel)
                    .where(filter)
                    .set(teamMember);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                return this.findById(filter.uuid);
            }
            return {};
        } catch (err) {
            this.logger.error({
                message: 'Error updating team member',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return err;
        }
    }

    async updateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            const existingTeamMembers = await this.teamMembersRepository.find({
                where: {
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    team: { uuid: organizationAndTeamData.teamId },
                },
            });

            const updatedTeamMembers = existingTeamMembers.map(
                (existingMember) => {
                    const memberUpdate = members.find(
                        (m) => m.uuid === existingMember.user.uuid,
                    );
                    if (memberUpdate) {
                        return {
                            ...existingMember,
                            name: memberUpdate.name,
                            status: memberUpdate.active,
                            avatar: memberUpdate.avatar,
                            communicationId: memberUpdate.communicationId,
                            communication: memberUpdate.communication,
                            codeManagement: memberUpdate.codeManagement,
                            projectManagement: memberUpdate.projectManagement,
                        };
                    }
                    return existingMember;
                },
            );

            await this.teamMembersRepository.save(updatedTeamMembers);
        } catch (err) {
            this.logger.error({
                message: 'Error updating team members',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            throw err;
        }
    }

    async deleteMembers(members: TeamMemberEntity[]): Promise<void> {
        await this.teamMembersRepository.update(
            members.map((member) => member.uuid),
            { status: false },
        );
    }
    //#endregion

    async getLeaderMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]> {
        try {
            const response = await this.teamMembersRepository
                .createQueryBuilder('team_member')
                .leftJoinAndSelect('team_member.user', 'user')
                .where('team_member.teamRole = :role', {
                    role: TeamMemberRole.TEAM_LEADER,
                })
                .andWhere('team_member.organization_id = :orgId', {
                    orgId: organizationAndTeamData.organizationId,
                })
                .andWhere('team_member.team_id = :teamId', {
                    teamId: organizationAndTeamData.teamId,
                })
                .getMany();

            return mapSimpleModelsToEntities(response, TeamMemberEntity);
        } catch (err) {
            this.logger.error({
                message: 'Error getting leader members',
                context: TeamMemberDatabaseRepository.name,
                error: err,
            });
            return null;
        }
    }
}
