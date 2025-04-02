import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';

export type ModuleWorkItemType = {
    name: string;
    workItemTypes: WorkItemType[];
};
