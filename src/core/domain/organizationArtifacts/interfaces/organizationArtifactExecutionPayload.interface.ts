import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ModuleWorkItemType } from '../../integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import {
    Item,
    ItemWithDeliveryStatus,
    WorkItemType,
} from '../../platformIntegrations/types/projectManagement/workItem.type';
import { IOrganizationArtifact } from './organizationArtifact.interface';
import { TeamArtifactsEntity } from '../../teamArtifacts/entities/teamArtifacts.entity';
import { SprintEntity } from '../../sprint/entities/sprint.entity';

export interface IOrganizationArtifacExecutiontPayload {
    organizationAndTeamData: OrganizationAndTeamData;
    bugTypeIdentifiers: Partial<WorkItemType>[];
    workItemTypes: ModuleWorkItemType[];
    frequenceType: string;
    teamMethodology: string;
    teamName: string;
    compiledSprints?: SprintEntity[];
    organizationArtifact?: IOrganizationArtifact;
    workItems?: Item[];
    teamMembers?: any;
    columns?: any;
    wipColumns?: any;
    period?: { startDate: string; endDate: string };
    waitingColumns?: any;
    metrics?: any;
    workItemsWithDeliveryStatus?: ItemWithDeliveryStatus[];
    throughputMetricsHistoric?: any;
    bugsInWip?: any[];
    organizationTeamArtifactsFromParameters?: any;
    teamArtifacts?: {
        mostRecentArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        };
        previousArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        }[];
    };
    workItemsCreatedInCurrentWeek?: Item[];
}
