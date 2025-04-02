import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { PlatformIntegrationFactory } from './platformIntegration.factory';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import {
    Item,
    WorkItem,
    WorkItemType,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { Board } from '@/core/domain/platformIntegrations/types/projectManagement/board.type';
import { ColumnBoard } from '@/core/domain/platformIntegrations/types/projectManagement/columnBoard.type';
import { Domain } from '@/core/domain/platformIntegrations/types/projectManagement/domain.type';
import { Project } from '@/core/domain/platformIntegrations/types/projectManagement/project.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import {
    ColumnsConfigResult,
    ColumnsConfigKey,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { WorkItemsFilter } from '@/core/domain/integrationConfigs/types/projectManagement/workItemsFilter.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ISprint } from '@/core/domain/platformIntegrations/interfaces/jiraSprint.interface';
import { extractOrganizationAndTeamData } from '@/shared/utils/helpers';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { ModuleWorkItemType } from '@/core/domain/integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { ProjectManagementConnectionStatus } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

@Injectable()
export class ProjectManagementService {
    constructor(
        @Inject(forwardRef(() => INTEGRATION_SERVICE_TOKEN))
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private platformIntegrationFactory: PlatformIntegrationFactory,
    ) {}

    //#region Get Configuration (Domain, Project, Board)
    async getDomain(params: any, type?: PlatformType): Promise<Domain[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getDomain(params);
    }

    async getProject(params: any, type?: PlatformType): Promise<Project[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getProject(params);
    }

    async getBoard(params: any, type?: PlatformType): Promise<Board[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getBoard(params);
    }

    async getBoardConfiguration(
        params: any,
        type?: PlatformType,
    ): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getBoardConfiguration(params);
    }
    //#endregion

    //#region Get Columns
    async getColumnBoard(
        params: any,
        type?: PlatformType,
    ): Promise<ColumnBoard[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getColumnBoard(params);
    }

    async getColumnsFormatted(
        params: any,
        type?: PlatformType,
    ): Promise<ColumnBoard[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getColumnsFormatted(params);
    }

    async getColumnsConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ColumnsConfigResult | undefined> {
        try {
            const columnsConfigKey =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    organizationAndTeamData,
                );

            if (!columnsConfigKey) {
                return undefined;
            }

            const todoColumns = columnsConfigKey
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'todo',
                )
                .map((columnConfig: ColumnsConfigKey) => columnConfig.id);

            const wipColumns = columnsConfigKey
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'wip',
                )
                .map((columnConfig: ColumnsConfigKey) => columnConfig.id);

            const doneColumns = columnsConfigKey
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'done',
                )
                .map((columnConfig: ColumnsConfigKey) => columnConfig.id);

            return {
                allColumns: columnsConfigKey,
                wipColumns,
                doneColumns,
                todoColumns,
            };
        } catch (error) {
            console.log(error);
        }
    }
    //#endregion

    //#region Get Teams And Members Data
    async getTeams(params: any, type?: PlatformType): Promise<Project[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getTeams(params);
    }

    async getListMembers(params: any, type?: PlatformType): Promise<any[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getListMembers(params);
    }
    //#endregion

    //#region Get Work Items
    async getWorkItems(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: WorkItemsFilter;
            useCache?: boolean;
            generateHistory?: boolean;
        },
        type?: PlatformType,
    ): Promise<WorkItem[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getAllWorkItems(params);
    }

    async getWorkItemById(params: any, type?: PlatformType): Promise<Item> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemById(params);
    }

    async getWorkItemsById(params: any, type?: PlatformType): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsById(params);
    }

    async getAllWorkItemsInWIP(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getAllWorkItemsInWIP(params);
    }

    async getWorkItemsByUpdatedDate(
        params: any,
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsByUpdatedDate(params);
    }

    async getWorkItemsByCreatedDateAndStatus(
        params: any,
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsByCreatedDateAndStatus(
            params,
        );
    }

    async getWorkItemsForDailyCheckin(
        params: any,
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsForDailyCheckin(params);
    }

    async getAllIssuesInWIPOrDoneMovementByPeriod(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
            params,
        );
    }

    async getWorkItemsBySprint(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            projectManagementSprintId: string;
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsBySprint(
            params.organizationAndTeamData,
            params.projectManagementSprintId,
            params.filters,
        );
    }

    async getWorkItemsByCurrentSprint(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemsByCurrentSprint(
            params.organizationAndTeamData,
            params.filters,
        );
    }
    //#endregion

    //#region Get Bug Work Items
    async getBugsInWip(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            bugTypeIdentifiers: Partial<WorkItemType>[];
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getBugsInWip(params);
    }

    async getNewBugsCreatedByPeriod(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: WorkItemsFilter;
        },
        type?: PlatformType,
    ): Promise<Item[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getNewBugsCreatedByPeriod(params);
    }
    //#endregion

    //#region Get Work Items Types
    async getWorkItemTypes(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getWorkItemTypes(params);
    }

    async getWorkItemsTypes(
        organizationAndTeamData,
        workItemType,
    ): Promise<WorkItemType[]> {
        const moduleWorkItemTypes =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ModuleWorkItemType[]
            >(IntegrationConfigKey.MODULE_WORKITEMS_TYPES, {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

        let workItemsTypes: WorkItemType[];

        if (workItemType === MODULE_WORKITEMS_TYPES.IMPROVE_TASK_DESCRIPTION) {
            workItemsTypes = moduleWorkItemTypes?.find(
                (workItemType) =>
                    workItemType.name ===
                    MODULE_WORKITEMS_TYPES.IMPROVE_TASK_DESCRIPTION,
            ).workItemTypes;
        }

        workItemsTypes = moduleWorkItemTypes?.find(
            (workItemType) =>
                workItemType.name === MODULE_WORKITEMS_TYPES.DEFAULT,
        ).workItemTypes;

        return workItemsTypes;
    }
    //#endregion

    //#region Get Sprints Data
    async getAllSprintsForTeam(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            originBoardId?: number;
        },
        type?: PlatformType,
    ) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getAllSprintsForTeam(
            params.organizationAndTeamData,
            params?.originBoardId,
        );
    }

    async getCurrentSprintForTeam(
        params: { organizationAndTeamData: OrganizationAndTeamData },
        type?: PlatformType,
    ) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getCurrentSprintForTeam(
            params.organizationAndTeamData,
        );
    }

    async getLastCompletedSprintForTeam(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            originBoardId?: number;
        },
        type?: PlatformType,
    ) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getLastCompletedSprintForTeam(
            params.organizationAndTeamData,
            params?.originBoardId,
        );
    }

    async getSprintByProjectManagementId(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            projectManagementSprintId: string;
        },
        type?: PlatformType,
    ): Promise<ISprint> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getSprintByProjectManagementId(
            params.organizationAndTeamData,
            params.projectManagementSprintId,
        );
    }

    async getNextSprintForTeam(
        params: {
            organizationAndTeamData: any;
            currentSprintId: string;
            originBoardId?: number;
        },
        type?: PlatformType,
    ): Promise<ISprint> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getNextSprintForTeam(
            params.organizationAndTeamData,
            params.currentSprintId,
            params?.originBoardId,
        );
    }
    //#endregion

    //#region Create and Update Data
    async createAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.createAuthIntegration(params);
    }

    async updateAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.updateAuthIntegration(params);
    }

    async createOrUpdateIntegrationConfig(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.createOrUpdateIntegrationConfig(params);
    }

    async createOrUpdateColumns(
        params: any,
        type?: PlatformType,
    ): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.createOrUpdateColumns(params);
    }
    //#endregion

    async getTypeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PlatformType> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: IntegrationCategory.PROJECT_MANAGEMENT,
                status: true,
            });

            if (!integration) {
                return null;
            }

            return integration.platform;
        } catch (error) {
            console.log(error);
        }
    }

    async getAuthUrl(params: any, type?: PlatformType): Promise<string> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getAuthUrl();
    }

    async getEpicsAndLinkedItems(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.getEpicsAndLinkedItems(params);
    }

    async verifyConnection(
        params: any,
        type?: PlatformType,
    ): Promise<ProjectManagementConnectionStatus> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const projectManagementService =
            this.platformIntegrationFactory.getProjectManagementService(type);

        return projectManagementService.verifyConnection(params);
    }
}
