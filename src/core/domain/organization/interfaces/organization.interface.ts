import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export interface IOrganization {
    uuid: string;
    name: string;
    tenantName: string;
    status: boolean;
    users?: Partial<IUser>[] | null;
    teams?: Partial<ITeam>[] | null;
}
