import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { STRING_TIME_INTERVAL } from '../../enums/stringTimeInterval.enum';

export type WorkItemsFilter = {
    createDate?: string;
    updatedDate?: string;
    workItemTypes?: Partial<WorkItemType>[];
    todayDate?: Date;
    getDescription?: boolean;
    wipStatuses?: string[];
    movementFilter?: any;
    statusesIds?: string[];
    stringTimeInterval?: STRING_TIME_INTERVAL;
    agingGreatherThen?: STRING_TIME_INTERVAL;
    workItemsIds?: string[];
    period?: {
        startDate: string;
        endDate: string;
    };
    expandChangelog?: boolean;
    showDescription?: boolean;
    assigneeFilter?: string[];
};
