import { AutomationStatus } from '../enums/automation-status';
import { IOrganizationAutomation } from './organization-automation.interface';

export interface IOrganizationAutomationExecution {
    uuid: string;
    createdAt?: Date;
    updatedAt?: Date;
    status: AutomationStatus;
    errorMessage?: string;
    dataExecution?: any;
    organizationAutomation?: Partial<IOrganizationAutomation>;
    origin: string;
}
