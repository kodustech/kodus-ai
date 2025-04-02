import { JiraAuthDetails } from './jiraAuthDetails.type';
import { WorkItemsFilter } from './workItemsFilter.type';

export type JiraParams = {
    organizationId?: string;
    jiraAuthDetails?: JiraAuthDetails;
    filters?: WorkItemsFilter;
};
