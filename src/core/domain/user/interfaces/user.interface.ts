import { STATUS } from '@/config/types/database/status.type';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ITeamMember } from '../../teamMembers/interfaces/team-members.interface';
import { UserRole } from '../enums/userRole.enum';

export interface IUser {
    uuid: string;
    password: string;
    email: string;
    status: STATUS;
    role: UserRole[];
    organization?: Partial<IOrganization> | null;
    teamMember?: Partial<ITeamMember>[] | null;
}
