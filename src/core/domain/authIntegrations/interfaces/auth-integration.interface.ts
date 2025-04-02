import { IIntegration } from '../../integrations/interfaces/integration.interface';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export interface IAuthIntegration {
    uuid: string;
    status: boolean;
    authDetails?: any;
    organization?: Partial<IOrganization>;
    team?: Partial<ITeam>;
    integration?: Partial<IIntegration>;
}
