import { STATUS } from '@/config/types/database/status.type';
import { TeamAutomationEntity } from '@/core/domain/automation/entities/team-automation.entity';
import {
    ITeamRepository,
    TEAM_REPOSITORY_TOKEN,
} from '@/core/domain/team/contracts/team.repository.contract';
import { ITeamService } from '@/core/domain/team/contracts/team.service.contract';
import { TeamEntity } from '@/core/domain/team/entities/team.entity';
import {
    ITeam,
    ITeamWithIntegrations,
    TeamsFilter,
} from '@/core/domain/team/interfaces/team.interface';
import { Inject, Injectable } from '@nestjs/common';
import { FindManyOptions } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class TeamService implements ITeamService {
    constructor(
        @Inject(TEAM_REPOSITORY_TOKEN)
        private readonly teamRepository: ITeamRepository,
    ) {}

    getTeamsByUserId(
        userId: string,
        organizationId: string,
        status?: STATUS[],
        options?: FindManyOptions<any>,
    ): Promise<TeamEntity[]> {
        return this.teamRepository.getTeamsByUserId(
            userId,
            organizationId,
            status,
            options,
        );
    }

    findFirstCreatedTeam(organizationId: string): Promise<TeamEntity> {
        return this.teamRepository.findFirstCreatedTeam(organizationId);
    }

    findOneByOrganizationId(organizationId: string): Promise<any> {
        return this.teamRepository.findOne({
            organization: { uuid: organizationId },
        });
    }

    async findOneOrganizationIdByTeamId(id: string): Promise<string> {
        const team = await this.teamRepository.findOne({ uuid: id });
        return team?.organization?.uuid;
    }

    find(
        filter?: Omit<Partial<ITeam>, 'status'>,
        status?: STATUS[],
        options?: FindManyOptions<any>,
    ): Promise<TeamEntity[]> {
        return this.teamRepository.find(filter, status, options);
    }

    findOne(filter: Partial<ITeam>): Promise<TeamEntity> {
        return this.teamRepository.findOne(filter);
    }

    findById(uuid: string): Promise<TeamEntity> {
        return this.teamRepository.findById(uuid);
    }

    findManyByIds(teamIds: string[]): Promise<TeamEntity[]> {
        throw new Error('Method not implemented.');
    }

    findTeamsWithIntegrations(
        params: TeamsFilter,
    ): Promise<ITeamWithIntegrations[]> {
        return this.teamRepository.findTeamsWithIntegrations(params);
    }

    /**
     * Filters team automations based on teams that meet the integration criteria
     * @param teamAutomations Array of team automations
     * @param teamsFilter Filter criteria for teams
     * @returns Promise with filtered array of team automations
     */
    async filterTeamAutomationsByConfiguredIntegrations(
        teamAutomations: TeamAutomationEntity[],
        teamsFilter: Partial<TeamsFilter>,
    ): Promise<TeamAutomationEntity[]> {
        const teamsWithIntegrations =
            await this.findTeamsWithIntegrations(teamsFilter);

        if (!teamsWithIntegrations?.length) {
            return [];
        }

        const validTeamIds = new Set(
            teamsWithIntegrations.map((team) => team.uuid),
        );

        return teamAutomations.filter((teamAutomation) =>
            validTeamIds.has(teamAutomation.team.uuid),
        );
    }

    create(teamEntity: ITeam): Promise<TeamEntity> {
        return this.teamRepository.create(teamEntity);
    }

    update(filter: Partial<ITeam>, data: Partial<ITeam>): Promise<TeamEntity> {
        return this.teamRepository.update(filter, data);
    }

    deleteOne(uuid: string): Promise<void> {
        return this.teamRepository.deleteOne(uuid);
    }

    async createTeam(body: {
        teamName: string;
        organizationId: string;
    }): Promise<TeamEntity | undefined> {
        const uuid = uuidv4();
        const { teamName: name } = body;

        return await this.teamRepository.create({
            name,
            uuid,
            status: STATUS.PENDING,
            organization: { uuid: body.organizationId },
        });
    }
}
