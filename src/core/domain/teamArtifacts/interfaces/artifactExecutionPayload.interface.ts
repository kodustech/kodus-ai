import { ModuleWorkItemType } from '../../integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ISprint } from '../../platformIntegrations/interfaces/jiraSprint.interface';
import {
    PullRequestCodeReviewTime,
    PullRequestWithFiles,
} from '../../platformIntegrations/types/codeManagement/pullRequests.type';
import {
    Item,
    WorkItemType,
} from '../../platformIntegrations/types/projectManagement/workItem.type';
import { ITeam } from '../../team/interfaces/team.interface';
import { IArtifact } from './artifact.interface';

export interface IArtifacExecutiontPayload {
    team?: ITeam;
    organization?: IOrganization;
    artifact?: IArtifact;
    workItems?: Item[];
    teamMembers?: any;
    columns?: any;
    wipColumns?: any;
    period?: { startDate: Date; endDate: Date };
    waitingColumns?: any;
    metrics?: any;
    workItemsDescriptionQuality: { score: number; dataAnalyzed: any };
    newBugsInTheLast24Hours: Item[];
    frequenceType: string;
    allWipTasks: Item[];
    sprints: { currentSprint?: ISprint; nextSprint?: ISprint };
    nextSprintWorkItems: Item[];
    bugTypeIdentifiers: Partial<WorkItemType>[];
    workItemTypes: ModuleWorkItemType[];
    pullRequestsWithFiles?: PullRequestWithFiles[];
    pullRequestsForRTTM?: PullRequestCodeReviewTime[];
    commitsByUser: any[];
}
