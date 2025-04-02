import {
    WorkItemType,
} from '../../platformIntegrations/types/projectManagement/workItem.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ProjectManagementConnectionStatus } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

export const JIRA_SERVICE_TOKEN = Symbol('JiraService');

export interface IJiraService {
    verifyConnection(params: any): Promise<ProjectManagementConnectionStatus>;
    findAndClearColumns(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    createOrUpdateColumns(params: any): Promise<void>;
    createOrUpdateBugTypes(params: any): Promise<void>;
    getProjectUsers(organizationId: string): Promise<
        {
            accountId: string;
            name: string;
            email: string;
        }[]
    >;
    getWorkItemTypes(params: any): Promise<WorkItemType[]>;
}
