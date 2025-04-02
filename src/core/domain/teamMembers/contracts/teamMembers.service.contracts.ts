import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IMembers } from '../interfaces/team-members.interface';
import { ITeamMemberRepository } from './teamMembers.repository.contracts';
import { IUser } from '../../user/interfaces/user.interface';

export const TEAM_MEMBERS_SERVICE_TOKEN = Symbol('TeamMembersService');

export interface ITeamMemberService extends ITeamMemberRepository {
    findTeamMembersFormated(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<{ members: IMembers[] }>;
    updateOrCreateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;

    sendInvitations(
        usersToSendInvitation: Partial<IUser[]>,
        organizationAndTeamData: OrganizationAndTeamData,
    );
}
