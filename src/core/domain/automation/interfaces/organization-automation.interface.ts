import { IOrganization } from '../../organization/interfaces/organization.interface';
import { IAutomation } from './automation.interface';

export interface IOrganizationAutomation {
    uuid?: string;
    status: boolean;
    automation?: Partial<IAutomation>;
    organization?: Partial<IOrganization>;
}
