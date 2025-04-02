import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ITeam } from '../../team/interfaces/team.interface';
import { IUser } from '../../user/interfaces/user.interface';
import { TeamMemberRole } from '../enums/teamMemberRole.enum';
import { ICodeManagementMemberConfig } from './codeManagementMemberConfig.interface';
import { ICommuminicationMemberConfig } from './communicationMemberConfig.interface';
import { IProjectManagementMemberConfig } from './projectManagementMemberConfig';

export interface IMembers {
    uuid?: string;
    active: boolean;
    communicationId: string;
    teamRole: TeamMemberRole;
    avatar?: string;
    name: string;
    communication?: { name: string; id: string; chatId?: string };
    codeManagement?: { name: string; id: string };
    projectManagement?: { name: string; id: string };
    email: string;
    userId?: string;
}
export interface ITeamMember {
    uuid?: string;
    organization?: Partial<IOrganization>;
    team?: Partial<ITeam>;
    user?: Partial<IUser>;
    status: boolean;
    communicationId?: string;
    avatar?: string;
    name?: string;
    teamRole: TeamMemberRole;
    communication?: ICommuminicationMemberConfig;
    codeManagement?: ICodeManagementMemberConfig;
    projectManagement?: IProjectManagementMemberConfig;
    createdAt?: Date;
}
