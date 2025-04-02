import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { WorkItemsFilter } from '../../integrationConfigs/types/projectManagement/workItemsFilter.type';
import { Board } from '../types/projectManagement/board.type';
import { ColumnBoard } from '../types/projectManagement/columnBoard.type';
import { Domain } from '../types/projectManagement/domain.type';
import { Project } from '../types/projectManagement/project.type';
import { User } from '../types/projectManagement/user.type';
import {
    Item,
    WorkItem,
} from '../types/projectManagement/workItem.type';
import { ICommonPlatformIntegrationService } from './common.interface';
import { ISprint } from './jiraSprint.interface';
import { Epic } from '../types/projectManagement/epic.type';
import { ColumnsConfigResult } from '../../integrationConfigs/types/projectManagement/columns.type';
import { ProjectManagementConnectionStatus } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

export interface IProjectManagementService
    extends ICommonPlatformIntegrationService {
    getAllWorkItems(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<WorkItem[]>;
    getBoard(params: any): Promise<Board[]>;
    getColumnBoard(params: any): Promise<ColumnBoard[]>;
    getColumnsFormatted(params: any): Promise<any>;
    getDomain(params: any): Promise<Domain[]>;
    getProject(params: any): Promise<Project[]>;
    getListMembers(params: any): Promise<User[]>;
    getAuthUrl(): Promise<string>;
    getAllIssuesInWIPOrDoneMovementByPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]>;
    getWorkItemsByCreatedDateAndStatus(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        createdAt: string;
        statusIds: string[];
        columnsConfig: ColumnsConfigResult;
    }): Promise<Item[]>;

    //TODO
    getTeams(params: any): Promise<any[]>;
    getBoardConfiguration(params: any): Promise<any>;
    getWorkItemById(params: any): Promise<Item>;
    getWorkItemsById(params: any): Promise<Item[]>;
    getWorkItemsByUpdatedDate(params: any): Promise<Item[]>;
    getListMembers(params: any): Promise<any[]>;
    verifyConnection(params: any): Promise<ProjectManagementConnectionStatus>;
    createOrUpdateColumns(params: any): Promise<void>;
    getWorkItemsForDailyCheckin(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]>;
    getNewBugsCreatedByPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]>;
    getBugsInWip(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        bugTypeIdentifiers: any[];
        filters: WorkItemsFilter;
    }): Promise<Item[]>;
    getAllWorkItemsInWIP(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]>;
    getWorkItemTypes(params: any);
    getAllSprintsForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
        originBoardId?: number,
    ): Promise<ISprint[]>;
    getCurrentSprintForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ISprint>;
    getLastCompletedSprintForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
        originBoardId?: number,
    ): Promise<ISprint>;
    getSprintByProjectManagementId(
        organizationAndTeamData: OrganizationAndTeamData,
        projectManagementSprintId: string,
    ): Promise<ISprint>;
    getWorkItemsBySprint(
        organizationAndTeamData: OrganizationAndTeamData,
        projectManagementSprintId: string,
        filters: WorkItemsFilter,
    ): Promise<Item[]>;

    getWorkItemsByCurrentSprint(
        organizationAndTeamData: OrganizationAndTeamData,
        filters: WorkItemsFilter,
    ): Promise<Item[]>;

    getNextSprintForTeam(
        organizationAndTeamData: any,
        currentSprintId: string,
        originBoardId?: number,
    ): Promise<ISprint>;

    getEpicsAndLinkedItems(params: any): Promise<Epic[]>;
}
