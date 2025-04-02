import { TeamEntity } from '@/core/domain/team/entities/team.entity';
import { ITeamRepository } from './team.repository.contract';
import { TeamAutomationEntity } from '../../automation/entities/team-automation.entity';
import { TeamsFilter } from '../interfaces/team.interface';

export const TEAM_SERVICE_TOKEN = Symbol('TeamService');

export interface ITeamService extends ITeamRepository {
    findOneOrganizationIdByTeamId(id: string): Promise<string>;
    createTeam(body: {
        teamName: string;
        organizationId: string;
    }): Promise<TeamEntity | undefined>;
    findOneByOrganizationId(organizationId: string): Promise<TeamEntity>;
    findFirstCreatedTeam(
        organizationId: string,
    ): Promise<TeamEntity | undefined>;
    filterTeamAutomationsByConfiguredIntegrations(
        teamAutomations: TeamAutomationEntity[],
        teamsFilter: Partial<TeamsFilter>,
    ): Promise<TeamAutomationEntity[]>;
}
