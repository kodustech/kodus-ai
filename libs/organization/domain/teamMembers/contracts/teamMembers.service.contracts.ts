import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { ITeamMemberRepository } from './teamMembers.repository.contracts';
import {
    IMembers,
    IUpdateOrCreateMembersResponse,
} from '../interfaces/teamMembers.interface';

export const TEAM_MEMBERS_SERVICE_TOKEN = Symbol.for('TeamMembersService');

export interface ITeamMemberService extends ITeamMemberRepository {
    findTeamMembersFormated(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<{ members: IMembers[] }>;
    updateOrCreateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
        inviterEmail?: string,
    ): Promise<IUpdateOrCreateMembersResponse>;

    sendInvitations(
        usersToSendInvitation: Partial<IUser[]>,
        organizationAndTeamData: OrganizationAndTeamData,
        inviterEmail?: string,
    );
}
