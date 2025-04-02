import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TeamMemberEntity } from '../entities/teamMember.entity';
import { IMembers, ITeamMember } from '../interfaces/team-members.interface';
import { STATUS } from '@/config/types/database/status.type';

export const TEAM_MEMBERS_REPOSITORY_TOKEN = Symbol('TeamMembersRepository');

export interface ITeamMemberRepository {
    countByUser(userId: string, teamMemberStatus?: boolean): Promise<number>;
    countTeamMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number>;
    create(teamMember: ITeamMember): Promise<any>;
    deleteMembers(members: TeamMemberEntity[]): Promise<void>;
    findManyByOrganizationId(
        organizationId: string,
        teamStatus: STATUS[],
    ): Promise<TeamMemberEntity[]>;
    findManyByRelations(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]>;
    findManyByUser(
        userId: string,
        teamMemberStatus: boolean,
    ): Promise<TeamMemberEntity[]>;
    findManyById(ids: string[]): Promise<TeamMemberEntity[]>;
    findMembersByCommunicationId(communicationId: string);
    findTeamMembersWithUser(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<TeamMemberEntity[]>;
    findOne(filter: Partial<ITeamMember>): Promise<TeamMemberEntity>;
    getLeaderMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]>;
    update(
        filter: Partial<ITeamMember>,
        teamMember: Partial<ITeamMember>,
    ): Promise<any>;
    updateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;
}
