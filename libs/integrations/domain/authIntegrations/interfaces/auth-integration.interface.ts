import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';

export interface IAuthIntegration<TIntegration = any> {
    uuid: string;
    status: boolean;
    authDetails?: any;
    organization?: Partial<IOrganization>;
    team?: Partial<ITeam>;
    integration?: Partial<TIntegration>;
    /** Set by TypeORM on every write of the row (CoreModel). */
    updatedAt?: Date;
}
