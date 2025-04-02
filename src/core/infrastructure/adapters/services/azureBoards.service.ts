import { AxiosAzureBoardsService } from '@/config/axios/microservices/azureBoards.axios';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { WorkItemsFilter } from '@/core/domain/integrationConfigs/types/projectManagement/workItemsFilter.type';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IProjectManagementService } from '@/core/domain/platformIntegrations/interfaces/project-management.interface';
import { Board } from '@/core/domain/platformIntegrations/types/projectManagement/board.type';
import { Domain } from '@/core/domain/platformIntegrations/types/projectManagement/domain.type';
import { Project } from '@/core/domain/platformIntegrations/types/projectManagement/project.type';
import { User } from '@/core/domain/platformIntegrations/types/projectManagement/user.type';
import {
    Item,
    WorkItem,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';

import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { StatusCategoryToColumn } from '@/shared/domain/enums/status-category-azure-boards.enum';

import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { getDoingAndWaitingColumns } from '@/shared/utils/langchainCommon/document';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ProjectManagementConnectionStatus } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

@Injectable()
@IntegrationServiceDecorator(PlatformType.AZURE_BOARDS, 'projectManagement')
export class AzureBoardsService
    implements
        Omit<
            IProjectManagementService,
            | 'getAllIssuesMovementByWeek'
            | 'getWorkItemsInWIP'
            | 'getWorkItemsForDailyCheckin'
            | 'getAllIssuesInWIPOrDoneMovementByWeek'
            | 'getChangelogForWorkItem'
            | 'getWorkItemTypes'
            | 'getAllWorkItemsInWIP'
            | 'getNewBugsCreatedByPeriod'
            | 'getWorkItemTypes'
            | 'getAllIssuesInWIPOrDoneMovementByPeriod'
            | 'getAllSprintsForTeam'
            | 'getCurrentSprintForTeam'
            | 'getLastCompletedSprintForTeam'
            | 'getSprintByProjectManagementId'
            | 'getColumnsFormatted'
            | 'getWorkItemsBySprint'
            | 'getWorkItemsByCurrentSprint'
            | 'getNextSprintForTeam'
            | 'getEpicsAndLinkedItems'
        >
{
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}
    getWorkItemsByCreatedDateAndStatus(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        createdAt: string;
        statusIds: string[];
        columnsConfig: ColumnsConfigResult;
    }): Promise<Item[]> {
        throw new Error('Method not implemented.');
    }
    getBugsInWip(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters?: WorkItemsFilter;
    }): Promise<Item[]> {
        throw new Error('Method not implemented.');
    }

    saveTeamArtifactsStructure(
        organizationAndTeamData: OrganizationAndTeamData,
        integration: any,
    ) {
        throw new Error('Method not implemented.');
    }

    private async getAuthIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            status: true,
            platform: PlatformType.AZURE_BOARDS,
        });
    }

    private async getAzureBoardsParams(params: any) {
        try {
            const integration = await this.getAuthIntegration(
                params.organizationId,
            );

            const { tenantId, organization, teamId, projectId, boardId } =
                integration.authIntegration.authDetails;

            return {
                teamId,
                projectId,
                boardId,
                client: new AxiosAzureBoardsService({
                    tenantId,
                    organization: params?.domainSelected || organization,
                }),
            };
        } catch (error) {
            console.log(error);
        }
    }

    async getAuthUrl(): Promise<string> {
        const client = new AxiosAzureBoardsService({});
        const { loginUrl } = await client.get('/api/azure-board-oauth');
        return loginUrl;
    }

    async getBoard(params: any): Promise<Board[]> {
        const { client } = await this.getAzureBoardsParams(params);
        const data = await client.get(
            `/api/projects/${params.projectId}/teams/${params.teamId}/boards`,
        );
        return (
            data?.filter((board) => board.name.toLowerCase() === 'issues') || []
        );
    }

    async getColumnBoard(params: any): Promise<any> {
        const { client, teamId, projectId, boardId } =
            await this.getAzureBoardsParams(params);

        let azureBoardsColumns = (await client.get(
            `/api/projects/${projectId}/teams/${teamId}/boards/${boardId}/columns`,
        )) as (any & { column?: string; index: number })[];

        if (!azureBoardsColumns) {
            throw new Error('Board columns not found');
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.COLUMNS_MAPPING, params.organizationId);

        if (!integrationConfig?.length) {
            azureBoardsColumns = azureBoardsColumns?.map((column) => {
                const newColumn = StatusCategoryToColumn[column?.columnType];
                return {
                    ...column,
                    column: newColumn ?? '',
                };
            });
        }

        const wipOrder = [];

        const formattedColumns = azureBoardsColumns.map((column) => {
            const userColumnConfig = integrationConfig?.find(
                (col) => col.id === column.id,
            );

            if (
                userColumnConfig?.column === 'wip' ||
                column?.column === 'wip'
            ) {
                wipOrder.push({
                    ...column,
                    index: userColumnConfig?.order ?? column?.index,
                });
            }
            return {
                name: column.name,
                id: column.id,
                column: userColumnConfig?.column || column?.column || '',
                index: column?.index,
            };
        });

        wipOrder?.sort((a, b) => a.index - b.index);

        const wipOrderFormated = wipOrder?.map((columnWip, index) => {
            return { ...columnWip, order: index + 1 };
        });

        const formattedColumnsWithWipOrder = formattedColumns
            .map((column) => {
                const wipConfig = wipOrderFormated?.find(
                    (col) => col.id === column.id,
                );

                return {
                    ...column,
                    order: column.column === 'wip' ? wipConfig?.order : null,
                    wipName: wipConfig?.order + '. ' + column.name,
                };
            })
            ?.sort((a, b) => a.order - b.order);

        return {
            isCreate: !integrationConfig,
            columns: formattedColumnsWithWipOrder,
        };
    }

    async getDomain(params: any): Promise<Domain[]> {
        const { client } = await this.getAzureBoardsParams(params);
        return client.get('/api/organizations');
    }

    async getProject(params: any): Promise<Project[]> {
        const { client } = await this.getAzureBoardsParams(params);
        return client.get('/api/projects');
    }

    async getTeams(params: any): Promise<any[]> {
        const { client } = await this.getAzureBoardsParams(params);
        return client.get(`/api/projects/${params.projectId}/teams`);
    }

    getBoardConfiguration(params: any): Promise<any> {
        return this.getColumnBoard(params);
    }

    async getAllWorkItems(params: any): Promise<WorkItem[]> {
        const { client, teamId, projectId, boardId } =
            await this.getAzureBoardsParams(params);

        return client.get(
            `/api/projects/${projectId}/teams/${teamId}/boards/${boardId}/work-items/formated`,
        );
    }

    async getWorkItemById(params: any): Promise<Item> {
        const { client, projectId, teamId, boardId } =
            await this.getAzureBoardsParams(params);

        return client.get(
            `api/projects/${projectId}/teams/${teamId}/boards/${boardId}/work-items/${params.issue_id}`,
        );
    }

    async getWorkItemsById(params: any): Promise<Item[]> {
        const promises = params.workItems.map((item) =>
            this.getWorkItemById({ ...params, issue_id: item.value }),
        );

        return (await Promise.all(promises)).flatMap((item) => item);
    }

    async getWorkItemsByUpdatedDate(params: any): Promise<Item[]> {
        const allWorkItems = await this.getAllWorkItems(params);
        const allItems = allWorkItems.flatMap((item) => item.workItems);

        return allItems.filter(({ changelog }) => {
            const { createdAt } = changelog[changelog.length - 1];
            return params?.updatedDate
                ? new Date(createdAt) > new Date(params.updatedDate)
                : true;
        });
    }

    async getListMembers(params: any): Promise<User[]> {
        const { client, teamId, projectId } =
            await this.getAzureBoardsParams(params);

        const response = await client.get(
            `/api/projects/${projectId}/teams/${teamId}/members`,
        );

        return response.map((member: any) => ({
            id: member.id,
            name: member.displayName,
            email: member.uniqueName,
        }));
    }

    async verifyConnection(
        params: any,
    ): Promise<ProjectManagementConnectionStatus> {
        if (!params.organizationAndTeamData.organizationId)
            return {
                platformName: PlatformType.AZURE_BOARDS,
                isSetupComplete: false,
                hasConnection: false,
                config: {},
            };

        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: {
                uuid: params.organizationAndTeamData.teamId,
            },
            status: true,
            platform: PlatformType.AZURE_BOARDS,
        });

        if (!integration) {
            return {
                platformName: PlatformType.AZURE_BOARDS,
                isSetupComplete: false,
                hasConnection: false,
                config: { url: null },
            };
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            configKey: IntegrationConfigKey.COLUMNS_MAPPING,
        });

        let url = '';

        const authDetails = integration?.authIntegration?.authDetails;

        const keys = ['teamId', 'boardId', 'projectId', 'organization'];

        if (
            !authDetails.tenantId ||
            !authDetails.organization ||
            !keys.every((key) => authDetails[key])
        )
            url = '/setup/azure-boards/configuration';
        else if (!integrationConfig?.configValue?.length)
            url = '/setup/azure-boards/configuration/select-columns';

        const isSetupComplete = !!(
            keys.every((key) => authDetails[key]) &&
            integrationConfig?.configValue?.length
        );

        const hasConnection = url?.length > 0 || isSetupComplete;

        return {
            platformName: 'azure-boards',
            isSetupComplete,
            hasConnection,
            config: { url },
            category: IntegrationCategory.PROJECT_MANAGEMENT,
        };
    }

    async createAuthIntegration(params: any): Promise<any> {
        try {
            const authUuid = uuidv4();

            const authIntegration = await this.authIntegrationService.create({
                uuid: authUuid,
                status: true,
                authDetails: {
                    tenantId: params.tenantId,
                },
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            const integrationUuid = uuidv4();

            return await this.integrationService.create({
                uuid: integrationUuid,
                platform: PlatformType.AZURE_BOARDS,
                integrationCategory: IntegrationCategory.PROJECT_MANAGEMENT,
                status: true,
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                authIntegration: { uuid: authIntegration.uuid },
            });
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    async updateAuthIntegration(params: any): Promise<any> {
        try {
            let tenantId = params.tenantId;
            if (!tenantId) {
                const integration = await this.getAuthIntegration(
                    params.organizationId,
                );
                tenantId = integration.authIntegration.authDetails.tenantId;
            }

            const response = await this.authIntegrationService.findOne({
                authDetails: { ['tenantId']: tenantId },
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
            });

            if (!response) throw new Error('Auth integration not found');

            await this.authIntegrationService.update(
                {
                    uuid: response.uuid,
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    team: { uuid: params.organizationAndTeamData.teamId },
                },
                {
                    status: true,
                    authDetails: {
                        ...response.authDetails,
                        ...params.authDetails,
                    },
                },
            );

            return {
                success: true,
            };
        } catch (error) {
            console.log(error);
            return {
                success: false,
            };
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: { uuid: params.organizationAndTeamData.teamId },
            platform: PlatformType.AZURE_BOARDS,
        });

        if (!integration) return;

        return await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.COLUMNS_MAPPING,
            params.columns,
            integration?.uuid,
            params.teamId,
        );
    }

    async createOrUpdateColumns(params: any): Promise<any> {
        const integration = await this.getAuthIntegration(
            params.organizationId,
        );

        if (!integration) return;

        await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.COLUMNS_MAPPING,
            params.columns,
            integration?.uuid,
            params.teamId,
        );

        setImmediate(() => {
            this.asyncDealWithWaitingAndDoingColumns(
                params.columns,
                integration,
                params.teamId,
            );
        });
    }

    private async asyncDealWithWaitingAndDoingColumns(
        columns,
        integration,
        teamId,
    ) {
        const { waitingColumns, doingColumn } =
            await getDoingAndWaitingColumns(columns);

        this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.DOING_COLUMN,
            doingColumn || {},
            integration?.uuid,
            teamId,
        );

        this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.WAITING_COLUMNS,
            waitingColumns.waiting_columns || [],
            integration?.uuid,
            teamId,
        );
    }
}
