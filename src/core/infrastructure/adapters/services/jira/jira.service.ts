import { IJiraService } from '@/core/domain/jira/contracts/jira.service.contract';
import { IProjectManagementService } from '@/core/domain/platformIntegrations/interfaces/project-management.interface';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Board } from '@/core/domain/platformIntegrations/types/projectManagement/board.type';
import { ColumnBoard } from '@/core/domain/platformIntegrations/types/projectManagement/columnBoard.type';
import { Domain } from '@/core/domain/platformIntegrations/types/projectManagement/domain.type';
import { Project } from '@/core/domain/platformIntegrations/types/projectManagement/project.type';
import {
    Item,
    WorkItem,
    WorkItemType,
    WorkItemWithChangelog,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { IntegrationServiceDecorator } from '@/shared/utils/decorators/integration-service.decorator';
import { StatusCategoryToColumn } from '@/shared/domain/enums/status-category-jira.enum';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import {
    prompt_getWaitingColumns,
    prompt_getBugTypes,
} from '@/shared/utils/langchainCommon/prompts';
import { prompt_getDoingColumnName } from '@/shared/utils/langchainCommon/prompts/configuration/getDoingColumnName';
import {
    AxiosErrorHandler,
    ErrorResponse,
} from '@/shared/utils/axios-error-handler';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { WorkItemsFilter } from '@/core/domain/integrationConfigs/types/projectManagement/workItemsFilter.type';
import { STRING_TIME_INTERVAL } from '@/core/domain/integrationConfigs/enums/stringTimeInterval.enum';
import { formatAndFilterChangelog } from './formats/formatChangelog';
import { formatWorkItems } from './formats/formatWorkItems';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { SPRINT_STATE } from '@/core/domain/sprint/enum/sprintState.enum';
import { ISprint } from '@/core/domain/platformIntegrations/interfaces/jiraSprint.interface';
import { artifacts } from '../teamArtifacts/artifactsStructure.json';
import { organizationArtifacts } from '../organizationArtifacts/organizationArtifactsStructure.json';

import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { IIntegration } from '@/core/domain/integrations/interfaces/integration.interface';
import { PinoLoggerService } from '../logger/pino.service';
import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { getDateRangeByEnumStringTimeInterval } from '@/shared/utils/transforms/date';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import { BoardPriorityType } from '@/shared/domain/enums/board-priority-type.enum';
import { formatWorkItem } from './formats/formatWorkItem';
import { Epic } from '@/core/domain/platformIntegrations/types/projectManagement/epic.type';
import { retryWithBackoff } from '@/shared/utils/helpers';
import { CacheService } from '@/shared/utils/cache/cache.service';
import {
    ProjectManagementConnectionStatus,
    ValidateProjectManagementIntegration,
} from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
@IntegrationServiceDecorator(PlatformType.JIRA, 'projectManagement')
export class JiraService
    implements
        IJiraService,
        Omit<
            IProjectManagementService,
            | 'getAuthUrl'
            | 'getTeams'
            | 'getWorkItemsInWIP'
            | 'getWorkItemsByUpdatedDate'
        >
{
    private axiosClient: AxiosJiraService;

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly projectManagementService: ProjectManagementService,

        private logger: PinoLoggerService,

        private readonly cacheService: CacheService,
    ) {
        this.axiosClient = new AxiosJiraService();
    }

    //#region AuthIntegration
    async createAuthIntegration(params: any): Promise<any> {
        const {
            data,
        }: {
            data: {
                access_token: string;
                token_type: string;
                refresh_token: string;
                expires_in: number;
            };
        } = await axios.post(process.env.API_JIRA_OAUTH_TOKEN_URL, {
            code: params.code,
            grant_type: 'authorization_code',
            redirect_uri: process.env.GLOBAL_JIRA_REDIRECT_URI,
            client_id: process.env.GLOBAL_JIRA_CLIENT_ID,
            client_secret: process.env.API_JIRA_CLIENT_SECRET,
        });

        const { data: newData } = await axios.get(
            `${process.env.API_JIRA_OAUTH_API_TOKEN_URL}/accessible-resources`,
            {
                headers: {
                    Authorization: `Bearer ${data?.access_token}`,
                },
            },
        );

        const moreInfosToAccessToken = {
            baseUrl: null,
            cloudId: null,
            isDomainUnique: undefined,
        };

        if (newData?.length === 1) {
            moreInfosToAccessToken['baseUrl'] = newData[0]?.url;
            moreInfosToAccessToken['cloudId'] = newData[0]?.id;
            moreInfosToAccessToken['isDomainUnique'] = true;
        }

        await this.addAccessToken({
            organizationAndTeamData: params.organizationAndTeamData,
            accessToken: data?.access_token,
            refreshToken: data?.refresh_token,
            expiresIn: data?.expires_in,
            ...moreInfosToAccessToken,
        });

        return {
            success: true,
        };
    }

    async updateAuthIntegration(params: any): Promise<void> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.JIRA,
            });

            if (!integration?.authIntegration?.uuid) {
                throw new NotFoundException('Integration not found');
            }

            const team = await this.teamService.findById(
                params.organizationAndTeamData.teamId,
            );

            const isSetupFinished = await this.isProjectManagementSetupFinished(
                params.organizationAndTeamData,
            );

            if (team && isSetupFinished) {
                return;
            }

            const authIntegration = await this.authIntegrationService.findOne({
                uuid: integration?.authIntegration?.uuid,
            });

            await this.authIntegrationService.update(
                {
                    uuid: authIntegration?.uuid,
                    organization: {
                        uuid: params.organizationAndTeamData.organizationId,
                    },
                    team: { uuid: params.organizationAndTeamData.teamId },
                },
                {
                    authDetails: {
                        ...authIntegration?.authDetails,
                        cloudId:
                            params.authDetails.organization?.id ??
                            authIntegration?.authDetails?.cloudId,
                        baseUrl: params.authDetails.organization?.url,
                    },
                },
            );

            await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                {
                    projectId: params.authDetails.projectSelected?.id,
                    projectKey: params.authDetails.projectSelected?.key,
                    boardId: params.authDetails.boardSelected?.id,
                },
                integration?.uuid,
                params.organizationAndTeamData,
            );

            const integrationConfigSetupConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            await this.saveTeamProjectManagementMethod(
                integration.uuid,
                {
                    teamId: team?.uuid,
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                },
                params.authDetails.boardSelected?.type,
            );

            if (
                integrationConfigSetupConfig?.boardId !==
                params.authDetails.boardSelected?.id
            ) {
                await this.findAndClearColumns(params.organizationAndTeamData);
            }

            if (
                integrationConfigSetupConfig?.boardId !==
                params.boardSelected?.id
            ) {
                await this.findAndClearBugTypes(params.organizationAndTeamData);
            }
        } catch (error) {
            console.error('Error updating integration:', error);
        }
    }

    private async ensureAuthenticatedIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            return await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.JIRA,
                status: true,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error executing ensureAuthenticatedIntegration',
                context: JiraService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });

            throw error;
        }
    }

    async addAccessToken({
        accessToken,
        organizationAndTeamData,
        ...integrationInfo
    }): Promise<IntegrationEntity> {
        const authUuid = uuidv4();

        const authIntegration = await this.authIntegrationService.create({
            uuid: authUuid,
            status: true,
            authDetails: {
                authToken: accessToken,
                platform: PlatformType.JIRA,
                ...integrationInfo,
            },
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        const integrationUuid = uuidv4();

        return this.integrationService.create({
            uuid: integrationUuid,
            platform: PlatformType.JIRA,
            integrationCategory: IntegrationCategory.PROJECT_MANAGEMENT,
            status: true,
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            authIntegration: { uuid: authIntegration?.uuid },
        });
    }
    //#endregion

    //#region Get Configurations (Domain, Boards, Projects, etc)
    async getDomain(params: any): Promise<Domain[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const { data } = await this.axiosClient.get(
                `${process.env.API_JIRA_OAUTH_API_TOKEN_URL}/accessible-resources`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId: params.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            // Maps the response to the structure of the Domain type
            const domains = data.map(
                (item: Domain): Domain => ({
                    name: item.name,
                    id: item.id,
                    url: item.url,
                    selected: item.id.includes(
                        integration?.authIntegration?.authDetails?.cloudId,
                    ),
                }),
            );

            return domains;
        } catch (error) {
            console.error('Error fetching domains:', error);
            throw error; // Re-throws the error to be handled by the caller
        }
    }

    async getProject(params: any): Promise<Project[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration?.authIntegration?.uuid) {
                throw new NotFoundException('Integration not found');
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            let startAt = 0;
            const maxResults = 50;
            let projects = [];
            let isLast = false;

            while (!isLast) {
                let url = this.buildProjectUrl(
                    params,
                    integration,
                    startAt,
                    maxResults,
                );

                const response = await this.axiosClient.get(url, {
                    headers: {
                        Authorization: `Bearer ${integration.authIntegration.authDetails.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                });

                projects = projects.concat(response.data.values ?? []);
                isLast = response.data.isLast;
                startAt += response.data.maxResults;
            }

            return projects
                .filter(
                    (project: { projectTypeKey: string }) =>
                        project.projectTypeKey === 'software',
                )
                .map((project: Project) => ({
                    name: project.name,
                    id: project.id,
                    key: project.key,
                    selected: project.id.includes(integrationConfig?.projectId),
                })) as Project[];
        } catch (error) {
            console.error('Error fetching projects:', error);
            throw error;
        }
    }

    async getBoard(params: any): Promise<Board[] | any> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            let startAt = 0;
            const maxResults = 50;
            let isLast = false;
            let boards: any[] = [];

            while (!isLast) {
                const url = this.buildBoardUrl(
                    params,
                    integration,
                    startAt,
                    maxResults,
                );
                const response = await this.axiosClient.get(url, {
                    headers: {
                        Authorization: `Bearer ${integration.authIntegration.authDetails.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                });

                const currentPageBoards = response.data.values ?? [];
                boards = boards.concat(currentPageBoards);
                isLast = response.data.isLast;
                startAt += currentPageBoards.length;
            }

            const boardsFiltered = boards
                ?.filter(
                    (board: { location: { projectId: number } }) =>
                        board?.location?.projectId ===
                        Number(params.projectSelected?.id),
                )
                ?.sort((a: { id: number }, b: { id: number }) => a.id - b.id);

            return boardsFiltered.map((board: Board) => ({
                id: board.id.toString(),
                name: board.name,
                selected: board.id
                    .toString()
                    .includes(integrationConfig?.boardId),
                type: board.type,
            })) as Board[];
        } catch (error) {
            const errorResponse: ErrorResponse =
                AxiosErrorHandler.createErrorResponse(error);

            return errorResponse;
        }
    }

    async getBoardConfiguration(params: any): Promise<any> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                throw new NotFoundException('Integration not found');
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const { data } = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/board/${integrationConfig?.boardId}/configuration`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            return data;
        } catch (error) {
            console.log('Error fetching boardConfig', error);
        }
    }
    //#endregion

    //#region Get Members/Users
    async getListMembers(params: any): Promise<any[]> {
        const members = await this.getProjectUsers(params);
        return members?.map((user) => {
            return {
                name: user.name,
                id: user.accountId,
                email: user.email,
            };
        });
    }

    async getUserIdsByNames(
        params: any,
        userNames: string[],
    ): Promise<
        {
            accountId: string;
            name: string;
            email: string;
        }[]
    > {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return [];
            }

            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const { data } = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/users/search?project=${integrationConfig?.projectId}&maxResults=1000`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            if (!data) {
                return [];
            }

            const users = data
                .filter(
                    (user: { accountType: string; active: boolean }) =>
                        user?.accountType === 'atlassian' &&
                        user?.active === true,
                )
                .map((user: any) => ({
                    accountId: user?.accountId,
                    name: user?.displayName,
                    email: user?.emailAddress,
                }));

            return users.filter((user) =>
                userNames.some((name) =>
                    user.name.toLowerCase().includes(name.toLowerCase()),
                ),
            );
        } catch (error) {
            console.log(error);
            return [];
        }
    }

    async getProjectUsers(params: any): Promise<
        {
            accountId: string;
            name: string;
            email: string;
        }[]
    > {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return [];
            }

            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const { data } = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/users/search?project=${integrationConfig?.projectId}&maxResults=1000`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            if (!data) {
                return [];
            }

            const users = data
                .filter(
                    (user: { accountType: string; active: boolean }) =>
                        user?.accountType === 'atlassian' &&
                        user?.active === true,
                )
                .map((user: any) => ({
                    accountId: user?.accountId,
                    name: user?.displayName,
                    email: user?.emailAddress,
                }));

            return users;
        } catch (error) {
            console.log(error);
        }
    }
    //#endregion

    //#region Get Columns
    async getColumnBoard(params: any): Promise<ColumnBoard[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const statuses = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/project/${integrationConfig?.projectId}/statuses`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            const projectStatuses = statuses?.data as {
                statuses: {
                    id: string;
                    name: string;
                    untranslatedName: string;
                    statusCategory: any;
                }[];
            }[];

            const boardConfiguration = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/board/${integrationConfig?.boardId}/configuration`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            const boardStatuses =
                boardConfiguration.data?.columnConfig?.columns.flatMap(
                    (column: { statuses: { id: string }[] }, index) =>
                        column.statuses?.map((status) => ({
                            ...status,
                            index,
                        })),
                );

            const boardStatusIds = boardStatuses.map(
                (status: { id: string }) => status.id,
            );

            const itemsInBoard = projectStatuses
                .flatMap((project) => project.statuses)
                .filter((status) => boardStatusIds.includes(status.id));

            const uniqueStatuses = {};

            itemsInBoard.forEach((status) => {
                if (!uniqueStatuses[status.id]) {
                    const findIndex = boardStatuses?.find(
                        (statuses) => statuses.id === status.id,
                    );

                    uniqueStatuses[status.id] = {
                        id: status.id,
                        name: status.name,
                        untranslatedName: status.untranslatedName,
                        statusCategory: status.statusCategory.key,
                        index: findIndex?.index,
                    };
                }
            });

            const filteredResult = Object.values(
                uniqueStatuses,
            ) as ColumnBoard[];

            return filteredResult;
        } catch (error) {
            console.log(error);
            throw new BadRequestException(error);
        }
    }

    async getDoingColumn(organizationId) {
        return await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
            IntegrationConfigKey.DOING_COLUMN,
            { organizationId },
        );
    }

    async getWaitingColumns(organizationId) {
        return await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
            IntegrationConfigKey.WAITING_COLUMNS,
            { organizationId },
        );
    }

    private async getDoingAndWaitingColumns(columns) {
        try {
            const llm = getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_TURBO,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            const wipColumns = columns
                .filter((column) => {
                    return column.column == 'wip';
                })
                .map((column) => {
                    return {
                        id: column.id,
                        name: column.name,
                    };
                });

            const promptWaitingColumns = prompt_getWaitingColumns(
                JSON.stringify(wipColumns),
            );

            const promptDoingColumn = prompt_getDoingColumnName(
                JSON.stringify(wipColumns),
            );

            const llmWaitingColmmnResponse = this.safelyParseMessageContent(
                (
                    await llm.invoke(promptWaitingColumns, {
                        metadata: { module: 'GetWaitingColumns' },
                    })
                ).content,
            );

            const llmDoingColumnResponse = this.safelyParseMessageContent(
                (
                    await llm.invoke(promptDoingColumn, {
                        metadata: { module: 'GetDoingColumns' },
                    })
                ).content,
            );

            return {
                waitingColumns: llmWaitingColmmnResponse,
                doingColumn: llmDoingColumnResponse,
            };
        } catch (error) {}
    }

    async getColumnsFormatted(params: any): Promise<any> {
        try {
            let columnsBoard = (await this.getColumnBoard({
                organizationAndTeamData: params.organizationAndTeamData,
            })) as (ColumnBoard & { column?: string; index: number })[];

            if (!columnsBoard) {
                throw new Error('Board columns not found');
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    params.organizationAndTeamData,
                );

            if (!integrationConfig?.length) {
                columnsBoard = columnsBoard?.map((column) => {
                    const newColumn =
                        StatusCategoryToColumn[column?.statusCategory];
                    return {
                        ...column,
                        column: newColumn ?? '',
                    };
                });
            }

            const wipOrder = [];

            const formattedColumns = columnsBoard.map((column) => {
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
                    name: column.untranslatedName,
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
                        order:
                            column.column === 'wip' ? wipConfig?.order : null,
                        wipName: wipConfig?.order + '. ' + column.name,
                    };
                })
                ?.sort((a, b) => a.order - b.order);

            return {
                isCreate: !integrationConfig,
                columns: formattedColumnsWithWipOrder,
            };
        } catch (error) {
            throw new BadRequestException(error);
        }
    }
    //#endregion

    //#region Get Work Item Types
    async getWorkItemTypes(params: any): Promise<WorkItemType[]> {
        const integration = await this.ensureAuthenticatedIntegration(
            params.organizationAndTeamData,
        );

        if (!integration) {
            return null;
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );

        const url = `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/issuetype/project?projectId=${integrationConfig?.projectId}`;

        const { data } = await this.axiosClient.get(url, {
            headers: {
                Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                organizationId: params.organizationAndTeamData.organizationId,
                platformType: PlatformType.JIRA,
            },
        });

        return data.map((issueType) => {
            return {
                id: issueType.id,
                name: issueType.untranslatedName,
                subtask: issueType.subtask,
                description: issueType.description,
            };
        });
    }

    async getIssueTypes(params: any) {
        const integration = await this.ensureAuthenticatedIntegration(
            params.organizationAndTeamData,
        );

        if (!integration) {
            return null;
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );

        const url = `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/issuetype/project?projectId=${integrationConfig?.projectId}`;

        const { data } = await this.axiosClient.get(url, {
            headers: {
                Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                organizationId: params.organizationAndTeamData.organizationId,
                platformType: PlatformType.JIRA,
            },
        });

        return data;
    }

    private getBugTypes = async (workItemTypes) => {
        try {
            const llm = getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_TURBO,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            const promptBugTypes = prompt_getBugTypes(
                JSON.stringify(workItemTypes),
            );

            const llmBugTypesResponse = this.safelyParseMessageContent(
                (
                    await llm.invoke(promptBugTypes, {
                        metadata: { module: 'GetBugTypes' },
                    })
                ).content,
            );

            return {
                bugTypes: llmBugTypesResponse.bug_type_identifier,
            };
        } catch (error) {}
    };

    async getBugTypeIdentifier(organizationId) {
        return await this.integrationConfigService.findOneIntegrationConfigWithIntegrations(
            IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
            { organizationId },
        );
    }
    //#endregion

    // #region Get WorkItems
    private async fetchIssuesFromAPI(
        integration,
        projectId,
        params: any,
        startAt: number,
        maxResults: number = 100,
    ) {
        const currentDate = new Date();
        const generateHistory = params.generateHistory || false;
        const defaultDays = generateHistory ? 180 : 90;

        const startDate = params?.filters?.period?.startDate
            ? new Date(params.filters.period.startDate)
            : new Date(
                  currentDate.setDate(currentDate.getDate() - defaultDays),
              );

        const endDate = params?.filters?.period?.endDate
            ? new Date(params.filters.period.endDate)
            : new Date();

        const formattedStartDate = startDate.toISOString().split('T')[0];
        const formattedEndDate = endDate.toISOString().split('T')[0];

        const dateFilter = `created >= "${formattedStartDate}" AND created <= "${formattedEndDate}"`;

        const USE_JQL_TO_VIEW_BOARD =
            await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                IntegrationConfigKey.USE_JQL_TO_VIEW_BOARD,
                params.organizationAndTeamData,
            );

        const filter = this.prepareWorkItemsTypesFilter(
            params?.filters?.workItemTypes,
        );

        let jqlFilter = this.adjustJQL(USE_JQL_TO_VIEW_BOARD || '', [
            filter,
            dateFilter,
        ]);

        const fields = [
            'key',
            'summary',
            'description',
            'status',
            'issuetype',
            'created',
            'updated',
            'lastViewed',
            'assignee',
            'priority',
            'subtasks',
            'project',
        ].join(',');

        const { url, headers } = this.buildBaseUrlAndHeader(
            params.organizationAndTeamData.organizationId,
            integration?.authIntegration?.authDetails?.cloudId,
            projectId,
            integration?.authIntegration?.authDetails?.authToken,
            `${jqlFilter}&fields=${fields}&expand=changelog&maxResults=${maxResults}&startAt=${startAt}`,
        );

        return await retryWithBackoff(
            async () => await this.axiosClient.get(url, { headers }),
        );
    }

    private async fetchAllIssues(integration, projectId, params: any) {
        const pageSize = 100;
        let startAt = 0;
        let totalIssues = 0;

        const fetchPage = async (startAt: number) => {
            const { data } = await this.fetchIssuesFromAPI(
                integration,
                projectId,
                params,
                startAt,
                pageSize,
            );

            if (data?.issues?.length > 0) {
                totalIssues = data.total;
                return data?.issues;
            }

            return [];
        };

        const firstPage = await fetchPage(startAt);
        if (!firstPage) {
            return [];
        }

        const totalPages = Math.ceil(totalIssues / pageSize);
        const promises = [];

        for (let i = 1; i < totalPages; i++) {
            startAt = i * pageSize;
            promises.push(fetchPage(startAt));
        }

        const results = await Promise.all(promises);
        const allIssues = [firstPage, ...results].flat();

        return allIssues;
    }

    async getAllWorkItems(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
        useCache?: boolean;
    }): Promise<WorkItem[]> {
        try {
            const { useCache = true } = params;
            const cacheKey = `jira_get_all_workitems_org_${params.organizationAndTeamData.organizationId}_team_${params.organizationAndTeamData.teamId}`;

            const cachedMetrics =
                await this.cacheService.getFromCache(cacheKey);

            if (cachedMetrics && useCache) {
                return cachedMetrics as WorkItem[];
            }

            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfigSetupConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const issues = await this.fetchAllIssues(
                integration,
                integrationConfigSetupConfig?.projectId,
                params,
            );

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    params.organizationAndTeamData,
                );

            const workItems = await this.transformIssuesToWorkItems(
                params.organizationAndTeamData,
                issues,
                integrationConfig,
                integration,
                params?.filters?.showDescription,
            );

            await this.cacheService.addToCache(cacheKey, workItems, 14400000); // 4 hours

            return workItems;
        } catch (error) {
            console.error('Error in getWorkTeam', error);
            throw new BadRequestException('Error fetching work items', error);
        }
    }

    async getAllWorkItemsInWIP(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const USE_JQL_TO_VIEW_BOARD =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.USE_JQL_TO_VIEW_BOARD,
                    params.organizationAndTeamData,
                );

            const workItemTypesFilter = this.prepareWorkItemsTypesFilter(
                params?.filters?.workItemTypes,
            );

            const agingFilter = this.prepareAgingFilters(
                params?.filters?.agingGreatherThen,
            );

            let jqlFilter = this.adjustJQL(USE_JQL_TO_VIEW_BOARD || '', [
                `status in (${params.filters.statusesIds})`,
                workItemTypesFilter,
                agingFilter,
            ]);

            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationAndTeamData.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                `${jqlFilter}&fields=*all&expand=changelog&maxResults=9999`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            if (!data?.issues) {
                return [];
            }

            const columnsConfig =
                await this.projectManagementService.getColumnsConfig(
                    params.organizationAndTeamData,
                );

            const wipColumns = columnsConfig.allColumns
                .filter((item) => item.column === 'wip')
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    order: item.order,
                }));

            const boardPriorityType = await this.parametersService.findByKey(
                ParametersKey.BOARD_PRIORITY_TYPE,
                params.organizationAndTeamData,
            );

            return formatWorkItems(
                data.issues,
                wipColumns,
                boardPriorityType,
                params.filters.movementFilter,
                params?.filters?.expandChangelog,
                params?.filters?.showDescription,
            );
        } catch (error) {
            console.log('Error fetching issue', error);
            throw error;
        }
    }

    async getAllIssuesInWIPOrDoneMovementByPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const USE_JQL_TO_VIEW_BOARD =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.USE_JQL_TO_VIEW_BOARD,
                    params.organizationAndTeamData,
                );

            const workItemsIds = params?.filters?.workItemsIds
                ?.map((item) => `"${item}"`)
                .join(',');

            const workItemsTypesFilter = this.prepareWorkItemsTypesFilter(
                params?.filters?.workItemTypes,
            );

            let statusesFilter = '';
            if (params?.filters?.statusesIds) {
                statusesFilter = ` AND status in (${params.filters.statusesIds})`;
            }

            let filterDate = '';

            if (params?.filters?.stringTimeInterval) {
                const { startDate, endDate } =
                    getDateRangeByEnumStringTimeInterval(
                        params?.filters?.stringTimeInterval,
                    );
                filterDate = this.buildDateFilter(startDate, endDate);
            } else if (params?.filters?.period) {
                const { startDate, endDate } = params?.filters?.period;
                filterDate = this.buildDateFilter(startDate, endDate);
            }

            let assigneeFilter = '';
            if (params?.filters?.assigneeFilter?.length > 0) {
                const assignees = await this.getUserIdsByNames(
                    params,
                    params.filters.assigneeFilter,
                );
                if (assignees.length > 0) {
                    assigneeFilter = ` AND assignee in (${assignees.map((assignee) => `"${assignee.accountId}"`).join(',')})`;
                }
            }

            // Build the JQL using the adjusted logic
            let jqlFilter = this.adjustJQL(USE_JQL_TO_VIEW_BOARD || '', [
                statusesFilter,
                workItemsTypesFilter,
                filterDate,
                assigneeFilter,
            ]);

            // Add the condition for workItemsIds
            if (workItemsIds) {
                jqlFilter += ` AND key in (${workItemsIds})`;
            }
            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationAndTeamData.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                `${jqlFilter}&fields=*all${params?.filters?.expandChangelog ? '&expand=changelog' : ''}&maxResults=9999`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            if (!data?.issues) {
                return [];
            }

            const columnsConfig =
                await this.projectManagementService.getColumnsConfig(
                    params.organizationAndTeamData,
                );

            const wipColumns = columnsConfig.allColumns
                .filter((item) => item.column === 'wip')
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    order: item.order,
                }));

            const boardPriorityType = await this.parametersService.findByKey(
                ParametersKey.BOARD_PRIORITY_TYPE,
                params.organizationAndTeamData,
            );

            return formatWorkItems(
                data.issues,
                wipColumns,
                boardPriorityType,
                params.filters.movementFilter,
                params?.filters?.expandChangelog,
                params?.filters?.showDescription,
            );
        } catch (error) {
            console.log('Error fetching issue', error);
            throw error;
        }
    }

    async getWorkItemsForDailyCheckin(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }): Promise<Item[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const filter = this.prepareWorkItemsTypesFilter(
                params?.filters?.workItemTypes,
            );

            const USE_JQL_TO_VIEW_BOARD =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.USE_JQL_TO_VIEW_BOARD,
                    params.organizationAndTeamData,
                );

            let jqlFilter = this.adjustJQL(USE_JQL_TO_VIEW_BOARD || '', [
                filter,
            ]);

            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationAndTeamData.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                `${jqlFilter}&fields=*all&expand=changelog&maxResults=100`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            if (!data?.issues) {
                return [];
            }

            const currentTime = params.filters.todayDate
                ? params.filters.todayDate.getTime()
                : new Date().getTime();

            const filteredIssues = data.issues.filter((x) => {
                // Check if there were changes in the last 24 hours
                const lastChangeTime =
                    x.changelog &&
                    x.changelog.histories &&
                    x.changelog.histories.length > 0
                        ? new Date(x.changelog.histories[0].created).getTime()
                        : new Date(x.created).getTime();

                // Compare if the last change was within the last 24 hours
                return currentTime - lastChangeTime <= 24 * 60 * 60 * 1000;
            });

            const columnsConfig =
                await this.projectManagementService.getColumnsConfig(
                    params.organizationAndTeamData,
                );

            const wipColumns = columnsConfig.allColumns
                .filter((item) => item.column === 'wip')
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    order: item.order,
                }));

            const boardPriorityType = await this.parametersService.findByKey(
                ParametersKey.BOARD_PRIORITY_TYPE,
                params.organizationAndTeamData,
            );

            return formatWorkItems(
                filteredIssues,
                wipColumns,
                boardPriorityType,
            );
        } catch (error) {
            console.error('Error fetching workItems:', error);
            throw error;
        }
    }

    async getWorkItemsBySprint(
        organizationAndTeamData: OrganizationAndTeamData,
        projectManagementSprintId: string,
        filters: WorkItemsFilter,
    ): Promise<Item[]> {
        if (!projectManagementSprintId) {
            return [];
        }

        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        let filter = this.prepareWorkItemsTypesFilter(
            filters?.workItemTypes,
            'jql',
        );

        const USE_JQL_TO_VIEW_BOARD =
            await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                IntegrationConfigKey.USE_JQL_TO_VIEW_BOARD,
                organizationAndTeamData,
            );

        let jqlFilter = this.adjustJQL(
            USE_JQL_TO_VIEW_BOARD || '',
            [filter],
            false,
        );

        // Build the URL
        const url = `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/sprint/${projectManagementSprintId}/issue?expand=changelog&maxResults=1000&jql=${jqlFilter}`;
        const { data } = await this.axiosClient.get(url, {
            headers: {
                Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                organizationId: organizationAndTeamData.organizationId,
                platformType: PlatformType.JIRA,
            },
        });

        if (!data?.issues || data.issues.length <= 0) {
            return [];
        }

        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        const wipColumns = columnsConfig.allColumns
            .filter((item) => item.column === 'wip')
            .map((item) => ({
                id: item.id,
                name: item.name,
                order: item.order,
            }));

        const boardPriorityType = await this.parametersService.findByKey(
            ParametersKey.BOARD_PRIORITY_TYPE,
            organizationAndTeamData,
        );

        return formatWorkItems(
            data.issues,
            wipColumns,
            boardPriorityType,
            filters?.movementFilter,
            filters?.expandChangelog,
            filters?.showDescription,
        );
    }

    async getWorkItemsByCurrentSprint(
        organizationAndTeamData: OrganizationAndTeamData,
        filters: WorkItemsFilter,
    ): Promise<Item[]> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const currentSprint = await this.getCurrentSprintForTeam(
            organizationAndTeamData,
        );

        const workItemTypesDefault =
            await this.projectManagementService.getWorkItemsTypes(
                organizationAndTeamData,
                MODULE_WORKITEMS_TYPES.DEFAULT,
            );

        filters.workItemTypes = workItemTypesDefault;

        return await this.getWorkItemsBySprint(
            organizationAndTeamData,
            currentSprint.id,
            filters,
        );
    }

    async getWorkItemsById(params: any): Promise<Item[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const workItemsIds = params.workItems
                .map((item) => `"${item}"`)
                .join(',');

            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                `%20and%20key%20in%20(${workItemsIds})&fields=*all&expand=changelog&maxResults=500`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            const columnsConfig =
                await this.projectManagementService.getColumnsConfig(
                    params.organizationAndTeamData,
                );

            const wipColumns = columnsConfig.allColumns
                .filter((item) => item.column === 'wip')
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    order: item.order,
                }));

            const boardPriorityType = await this.parametersService.findByKey(
                ParametersKey.BOARD_PRIORITY_TYPE,
                params.organizationAndTeamData,
            );

            return formatWorkItems(
                data.issues,
                wipColumns,
                boardPriorityType,
                params.filters?.movementFilter,
                params?.filters?.expandChangelog,
                params?.filters?.showDescription,
            );
        } catch (error) {
            console.log('Error fetching issue', error);
        }
    }

    async getWorkItemById(params: {
        organizationId: string;
        issue_id: string;
    }): Promise<Item> {
        try {
            const integration = await this.ensureAuthenticatedIntegration({
                organizationId: params.organizationId,
            });

            if (!integration) {
                return null;
            }

            const issue = await this.axiosClient.get(
                `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/issue/${params.issue_id}/?expand=changelog&fieldsByKeys=true`,
                {
                    headers: {
                        Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                        organizationId: params.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            return {
                id: issue?.data?.id,
                key: issue?.data?.key,
                name: issue?.data?.fields?.summary,
                description: issue?.data?.fields?.description || '',
                changelog: issue?.data?.changelog?.histories.map(
                    (changelog) => ({
                        id: changelog.id,
                        createdAt: changelog.created,
                        movements: changelog.items.map((item) => ({
                            field: item.field,
                            fromColumnId: item.from,
                            fromColumnName: item.fromString,
                            toColumnId: item.to,
                            toColumnName: item.toString,
                        })),
                    }),
                ),
                workItemCreatedAt: issue?.data?.fields?.created,
                columnName: issue?.data?.fields?.status?.name,
                assignee: {
                    accountId: issue?.data?.fields?.assignee?.accountId,
                    userEmail: issue?.data?.fields?.assignee?.emailAddress,
                    userName: issue?.data?.fields?.assignee?.displayName,
                },
                workItemType: {
                    name: issue?.data?.fields?.issuetype?.name,
                    id: issue?.data?.fields?.issuetype?.id,
                    description: issue?.data?.fields?.issuetype?.description,
                    subtask: issue?.data?.fields?.issuetype?.subtask,
                },
                status: {
                    name: issue?.data?.fields?.status?.name,
                    id: issue?.data?.fields?.status?.id,
                    statusCategory: {
                        name: issue?.data?.fields?.status?.statusCategory?.name,
                        id: issue?.data?.fields?.status?.statusCategory?.id,
                    },
                },
            };
        } catch (error) {
            console.log('Error fetching issue', error);
        }
    }

    async getWorkItemsByCreatedDateAndStatus(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        createdAt: string;
        statusIds: string[];
        columnsConfig: ColumnsConfigResult;
        filters: WorkItemsFilter;
    }): Promise<Item[]> {
        try {
            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return null;
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationAndTeamData.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                `%20and%20createdDate%20>=%20"${params.createdAt}"%20and%20status%20IN%20(${params.statusIds})&fields=*all&expand=changelog&maxResults=500`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            const wipColumns = params.columnsConfig.allColumns
                .filter((item) => item.column === 'wip')
                .map((item) => ({
                    id: item.id,
                    name: item.name,
                    order: item.order,
                }));

            return formatWorkItems(data.issues, wipColumns, params.filters);
        } catch (error) {
            console.log(
                'Error fetching Work Items by creation date and Status',
                error,
            );
        }
    }

    async getChangelogForWorkItem(params: {
        organizationId: string;
        workItemId: string;
    }): Promise<WorkItemWithChangelog> {
        const integration = await this.ensureAuthenticatedIntegration({
            organizationId: params.organizationId,
        });

        if (!integration) {
            return null;
        }

        const changelog = await this.axiosClient.get(
            `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_MID_URL}/issue/${params.workItemId}/changelog`,
            {
                headers: {
                    Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                    organizationId: params.organizationId,
                    platformType: PlatformType.JIRA,
                },
            },
        );

        return {
            key: params.workItemId,
            changelog: formatAndFilterChangelog(
                changelog,
                (field) => field.field === 'status',
            ),
        };
    }
    // #endregion

    // #region Get Bugs
    async getBugsInWip(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        bugTypeIdentifiers: Partial<WorkItemType>[];
        filters: WorkItemsFilter;
    }) {
        const integration = await this.ensureAuthenticatedIntegration(
            params.organizationAndTeamData,
        );

        if (!integration) {
            return null;
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );

        const typesIds = params.bugTypeIdentifiers
            .map((item) => `"${item.id}"`)
            .join(',');

        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                params.organizationAndTeamData,
            );

        const wipColumnsForQuery = columnsConfig.wipColumns
            .map((item) => `"${item}"`)
            .join(',');

        const filterString = `%20AND%20issuetype%20IN%20(${typesIds})%20AND%20status%20IN%20(${wipColumnsForQuery})`;

        const { url, headers } = this.buildBaseUrlAndHeader(
            params.organizationAndTeamData.organizationId,
            integration?.authIntegration?.authDetails?.cloudId,
            integrationConfig?.projectId,
            integration?.authIntegration?.authDetails?.authToken,
            `${filterString}&fields=*all&expand=changelog&maxResults=100`,
        );

        const { data } = await this.axiosClient.get(url, {
            headers,
        });

        if (!data?.issues || data.issues.length <= 0) {
            return [];
        }

        const wipColumns = columnsConfig.allColumns
            .filter((item) => item.column === 'wip')
            .map((item) => ({
                id: item.id,
                name: item.name,
                order: item.order,
            }));

        const boardPriorityType = await this.parametersService.findByKey(
            ParametersKey.BOARD_PRIORITY_TYPE,
            params.organizationAndTeamData,
        );

        return formatWorkItems(
            data.issues,
            wipColumns,
            boardPriorityType,
            params?.filters?.movementFilter,
            params?.filters?.expandChangelog,
            params?.filters?.showDescription,
        );
    }

    async getNewBugsCreatedByPeriod(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        filters: WorkItemsFilter;
    }) {
        const integration = await this.ensureAuthenticatedIntegration(
            params.organizationAndTeamData,
        );

        if (!integration) {
            return null;
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );

        const typesIds = params.filters.workItemTypes
            .map((item) => `"${item.id}"`)
            .join(',');

        const filterString = `%20AND%20issuetype%20IN%20(${typesIds}) AND created >= ${params.filters.stringTimeInterval}`;

        const { url, headers } = this.buildBaseUrlAndHeader(
            params.organizationAndTeamData.organizationId,
            integration?.authIntegration?.authDetails?.cloudId,
            integrationConfig?.projectId,
            integration?.authIntegration?.authDetails?.authToken,
            `${filterString}&fields=*all&expand=changelog&maxResults=100`,
        );

        const { data } = await this.axiosClient.get(url, {
            headers,
        });

        if (!data?.issues || data.issues.length <= 0) {
            return [];
        }

        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                params.organizationAndTeamData,
            );

        const wipColumns = columnsConfig.allColumns
            .filter((item) => item.column === 'wip')
            .map((item) => ({
                id: item.id,
                name: item.name,
                order: item.order,
            }));

        const boardPriorityType = await this.parametersService.findByKey(
            ParametersKey.BOARD_PRIORITY_TYPE,
            params.organizationAndTeamData,
        );

        return formatWorkItems(data.issues, wipColumns, boardPriorityType);
    }
    //#endregion

    // #region Get Epics
    @ValidateProjectManagementIntegration({ allowPartialTeamConnection: true })
    async getEpicsAndLinkedItems(params: any): Promise<Epic[]> {
        try {
            if (!params.organizationAndTeamData.organizationId) {
                return [];
            }

            const integration = await this.ensureAuthenticatedIntegration(
                params.organizationAndTeamData,
            );

            if (!integration) {
                return [];
            }

            const integrationConfig =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    boardId: string;
                    projectId: string;
                    projectKey: string;
                }>(
                    IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                    params.organizationAndTeamData,
                );

            if (!integrationConfig) {
                return [];
            }

            const { url, headers } = this.buildBaseUrlAndHeader(
                params.organizationAndTeamData.organizationId,
                integration?.authIntegration?.authDetails?.cloudId,
                integrationConfig?.projectId,
                integration?.authIntegration?.authDetails?.authToken,
                ` AND issuetype=Epic`,
            );

            const { data } = await this.axiosClient.get(url, {
                headers,
            });

            if (!data?.issues) {
                return [];
            }

            const epics = data?.issues.map((issue) => ({
                id: issue.id,
                key: issue.key,
                status: issue.fields.status,
                name: issue.fields.summary,
            }));

            const epicsLinkedItens = [];

            for (let index = 0; index < epics?.length; index++) {
                const epic = epics[index];

                const result = await this.getItemsLinkedToEpic({
                    organizationAndTeamData: params.organizationAndTeamData,
                    cloudId: integration?.authIntegration?.authDetails?.cloudId,
                    projectId: integrationConfig?.projectId,
                    authToken:
                        integration?.authIntegration?.authDetails?.authToken,
                    epicKey: epic.id,
                });

                epicsLinkedItens.push({ ...epic, issues: result });
            }

            return epicsLinkedItens;
        } catch (error) {
            console.log(error);
        }
    }

    private async getItemsLinkedToEpic({
        organizationAndTeamData,
        cloudId,
        projectId,
        authToken,
        epicKey,
    }): Promise<Item[]> {
        const workItemTypesDefault =
            await this.projectManagementService.getWorkItemsTypes(
                organizationAndTeamData,
                MODULE_WORKITEMS_TYPES.DEFAULT,
            );

        const filter = this.prepareWorkItemsTypesFilter(
            workItemTypesDefault,
            'jql',
        );

        const pathConfig = ` AND ${filter} AND issuetype!=Epic AND "Epic Link"=${epicKey}&fields=*all&expand=changelog&maxResults=100`;

        const { url, headers } = this.buildBaseUrlAndHeader(
            organizationAndTeamData.organizationId,
            cloudId,
            projectId,
            authToken,
            pathConfig,
        );

        const { data } = await this.axiosClient.get(url, {
            headers,
        });

        return data.issues.map((item) => formatWorkItem(item));
    }
    // #endregion

    //#region Get Sprints
    async getAllSprintsForTeam(
        organizationAndTeamData: OrganizationAndTeamData,
        originBoardId?: number,
    ): Promise<ISprint[]> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

        let sprints = await this.getSprints(
            integration,
            integrationConfig,
            organizationAndTeamData,
        );

        if (sprints && sprints.length > 0 && originBoardId) {
            sprints = sprints.filter(
                (sprint) => sprint.originBoardId === originBoardId,
            );
        }

        return sprints?.map((sprint) => {
            return {
                id: sprint.id,
                name: sprint.name,
                startDate: new Date(sprint.startDate),
                endDate: new Date(sprint.endDate),
                completeDate: new Date(sprint.completeDate),
                state: sprint.state,
                goal: sprint.goal,
                originBoardId: sprint?.originBoardId,
            };
        });
    }

    async getCurrentSprintForTeam(
        organizationAndTeamData: any,
    ): Promise<ISprint> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

        const data = await this.getSprints(
            integration,
            integrationConfig,
            organizationAndTeamData,
            SPRINT_STATE.ACTIVE,
        );

        return data?.map((sprint) => {
            return {
                id: sprint.id,
                name: sprint.name,
                startDate: new Date(sprint.startDate),
                endDate: new Date(sprint.endDate),
                completeDate: new Date(sprint?.completeDate),
                state: sprint.state,
                goal: sprint.goal,
                originBoardId: sprint?.originBoardId,
            };
        })[0];
    }

    async getNextSprintForTeam(
        organizationAndTeamData: any,
        currentSprintId: string,
        originBoardId?: number,
    ): Promise<ISprint> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const sprints = await this.getAllSprintsForTeam(
            organizationAndTeamData,
            originBoardId,
        );

        if (!sprints) {
            return null;
        }

        const currentSprintIndex = sprints.findIndex(
            (sprint) => sprint.id === currentSprintId,
        );

        if (
            currentSprintIndex === -1 ||
            currentSprintIndex + 1 > sprints.length
        ) {
            return null;
        }

        return sprints[currentSprintIndex + 1];
    }

    async getLastCompletedSprintForTeam(
        organizationAndTeamData,
        originBoardId?: number,
    ): Promise<ISprint> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

        let sprints = await this.getSprints(
            integration,
            integrationConfig,
            organizationAndTeamData,
            SPRINT_STATE.CLOSED,
        );

        if (!sprints || sprints.length === 0) {
            return;
        }

        if (originBoardId) {
            sprints = sprints.filter(
                (sprint) => sprint.originBoardId === originBoardId,
            );
        }

        const sortedSprints = sprints
            ?.sort((a: any, b: any) => {
                return (
                    new Date(b.completeDate).getTime() -
                    new Date(a.completeDate).getTime()
                );
            })
            .map((sprint) => {
                return {
                    id: sprint.id,
                    name: sprint.name,
                    startDate: new Date(sprint.startDate),
                    endDate: new Date(sprint.endDate),
                    completeDate: new Date(sprint.completeDate),
                    state: sprint.state,
                    goal: sprint.goal,
                    originBoardId: sprint?.originBoardId,
                };
            });

        return sortedSprints?.[0];
    }

    private async getSprints(
        integration: IIntegration,
        integrationConfig: {
            boardId: string;
            projectId: string;
            projectKey: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
        sprintState?: SPRINT_STATE,
    ) {
        try {
            const url = `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/board/${integrationConfig?.boardId}/sprint`;

            const { data } = await this.axiosClient.get(url, {
                params: {
                    state: sprintState,
                },
                headers: {
                    Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                    organizationId: organizationAndTeamData.organizationId,
                    platformType: PlatformType.JIRA,
                },
            });

            if (!data || data.values.length <= 0) {
                return null;
            }

            return data.values;
        } catch (error) {
            console.log('teste', error);
        }
    }

    async getSprintByProjectManagementId(
        organizationAndTeamData: OrganizationAndTeamData,
        projectManagementSprintId: string,
    ): Promise<ISprint> {
        const integration = await this.ensureAuthenticatedIntegration(
            organizationAndTeamData,
        );

        if (!integration) {
            throw new NotFoundException('Integration not found');
        }

        const url = `${process.env.API_JIRA_BASE_URL}/${integration?.authIntegration?.authDetails?.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/sprint/${projectManagementSprintId}`;

        const { data } = await this.axiosClient.get(url, {
            headers: {
                Authorization: `Bearer ${integration?.authIntegration?.authDetails?.authToken}`,
                organizationId: organizationAndTeamData.organizationId,
                platformType: PlatformType.JIRA,
            },
        });

        return {
            id: data.id,
            name: data.name,
            startDate: new Date(data.startDate),
            endDate: new Date(data.endDate),
            completeDate: data.completeDate
                ? new Date(data.completeDate)
                : null,
            state: data.state,
            goal: data.goal,
            originBoardId: data?.originBoardId,
        };
    }
    //#endregion

    //#region Deals
    private async asyncDealWithWorkItemsTypes(
        organizationAndTeamData: OrganizationAndTeamData,
        integration,
    ) {
        const issueTypes = (
            await this.getIssueTypes({ organizationAndTeamData })
        ).map((issueType) => {
            return {
                id: issueType.id,
                name: issueType.untranslatedName,
                subtask: issueType.subtask,
                description: issueType.description,
            };
        });
        const moduleWorkItemsTypes = [];

        for (const moduleKey of Object.keys(MODULE_WORKITEMS_TYPES)) {
            moduleWorkItemsTypes.push({
                name: MODULE_WORKITEMS_TYPES[moduleKey],
                workItemTypes: issueTypes,
            });
        }

        await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.MODULE_WORKITEMS_TYPES,
            moduleWorkItemsTypes,
            integration?.uuid,
            organizationAndTeamData,
        );
    }

    private async asyncDealWithWaitingAndDoingColumns(
        columns,
        integration,
        organizationAndTeamData,
    ) {
        const { waitingColumns, doingColumn } =
            await this.getDoingAndWaitingColumns(columns);

        this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.DOING_COLUMN,
            doingColumn || {},
            integration?.uuid,
            organizationAndTeamData,
        );

        this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.WAITING_COLUMNS,
            waitingColumns.waiting_columns || [],
            integration?.uuid,
            organizationAndTeamData,
        );
    }

    private async asyncDealWithBugTypes(
        workItemsTypes,
        integration,
        organizationAndTeamData,
    ) {
        const { bugTypes } = await this.getBugTypes(workItemsTypes);

        this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
            bugTypes || {},
            integration?.uuid,
            organizationAndTeamData,
        );
    }
    //#endregion

    //#region Create/Update
    async createOrUpdateColumns(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params.organizationAndTeamData.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.JIRA,
            });

            if (!integration) {
                return;
            }

            const team = await this.teamService.findById(
                params.organizationAndTeamData.teamId,
            );

            await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.COLUMNS_MAPPING,
                params.columns,
                integration?.uuid,
                params.organizationAndTeamData,
            );

            const workItemsTypes = await this.getWorkItemTypes(params);

            const workItems = await this.getAllWorkItems(params);

            const isSetupFinished = await this.isProjectManagementSetupFinished(
                params.organizationAndTeamData,
            );

            await this.asyncDealWithWaitingAndDoingColumns(
                params.columns,
                integration,
                params.organizationAndTeamData,
            );

            if (team && !isSetupFinished) {
                await this.asyncDealWithWorkItemsTypes(
                    params.organizationAndTeamData,
                    integration,
                );

                await this.asyncDealWithBugTypes(
                    workItemsTypes,
                    integration,
                    params.organizationAndTeamData,
                );
            }

            await this.saveTeamArtifactsStructure(
                integration,
                params.organizationAndTeamData,
            );

            await this.saveOrganizationArtifactsStructure(
                integration,
                params.organizationAndTeamData,
            );

            await this.saveBoardPriorityType(
                workItems,
                integration,
                params.organizationAndTeamData,
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async createOrUpdateBugTypes(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: {
                    uuid: params?.organizationAndTeamData?.organizationId,
                },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.JIRA,
            });

            if (!integration) {
                return;
            }

            await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
                params.workItemTypes,
                integration?.uuid,
                {
                    teamId: params?.teamId,
                    organizationId: params?.organizationId,
                },
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async createOrUpdateIntegrationConfig(params: any): Promise<any> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: params.organizationId },
                team: { uuid: params.organizationAndTeamData.teamId },
                platform: PlatformType.JIRA,
            });

            if (!integration) {
                return;
            }

            return await this.integrationConfigService.createOrUpdateConfig(
                IntegrationConfigKey.COLUMNS_MAPPING,
                params.columns,
                integration?.uuid,
                {
                    teamId: params.teamId,
                },
            );
        } catch (err) {
            throw new BadRequestException(err);
        }
    }
    //#endregion

    //#region Prepare Filters
    private buildDateFilter(
        startDate: string | undefined,
        endDate: string | undefined,
    ): string {
        const formattedStartDate = startDate
            ? encodeURIComponent(startDate)
            : '';
        const formattedEndDate = endDate ? encodeURIComponent(endDate) : '';

        return formattedStartDate && formattedEndDate
            ? `%20AND%20updated%20>=%20"${formattedStartDate}"%20AND%20updated%20<=%20"${formattedEndDate}"`
            : '';
    }

    private prepareWorkItemsTypesFilter(
        workItemTypes: Partial<WorkItemType>[],
        type?: string,
    ) {
        let filterString = '';

        if (workItemTypes && workItemTypes.length > 0) {
            const typesIds = workItemTypes
                .map((item) => `"${item.id}"`)
                .join(',');

            if (type !== null && type !== 'jql')
                filterString += ` AND issuetype IN (${typesIds})`;
            else filterString += `issuetype IN (${typesIds})`;
        }

        return filterString;
    }

    private prepareAgingFilters(agingGreatherThen: STRING_TIME_INTERVAL) {
        let filterString = '';

        if (agingGreatherThen) {
            filterString += ` AND created <= ${agingGreatherThen}`;
        }

        return filterString;
    }
    //#endregion

    //#region Build URLs
    private buildBoardUrl(
        params: any,
        integration: any,
        startAt: number,
        maxResults: number,
    ): string {
        const domainId =
            params.domainSelected?.id ??
            integration.authIntegration.authDetails.cloudId;

        return `${process.env.API_JIRA_BASE_URL}/${domainId}/${process.env.API_JIRA_URL_API_VERSION_1}/board?projectLocation=${params.projectSelected?.id}&startAt=${startAt}&maxResults=${maxResults}&includePrivate=true`;
    }

    private buildProjectUrl(
        params: any,
        integration: any,
        startAt: number,
        maxResults: number,
    ): string {
        const domainId =
            params.domainSelected?.id ??
            integration.authIntegration.authDetails.cloudId;

        return `${process.env.API_JIRA_BASE_URL}/${domainId}/${process.env.API_JIRA_MID_URL}/project/search?startAt=${startAt}&maxResults=${maxResults}&typeKey=software`;
    }

    private buildBaseUrlAndHeader(
        organizationId: string,
        cloudId: string,
        projectId: string,
        authToken: string,
        pathConfig: string,
    ) {
        return {
            url: `${process.env.API_JIRA_BASE_URL}/${cloudId}/${process.env.API_JIRA_MID_URL}/search?jql=project=${projectId}${pathConfig}`,
            headers: {
                Authorization: `Bearer ${authToken}`,
                organizationId: organizationId,
                platformType: PlatformType.JIRA,
            },
        };
    }
    //#endregion

    //#region Save Functions
    async saveTeamArtifactsStructure(integration, organizationAndTeamData) {
        try {
            const teamMethodology =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                    organizationAndTeamData,
                );

            const azureRepos = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: PlatformType.AZURE_REPOS,
            });

            const teamArtifacts = artifacts.map((artifact) => {
                let status = artifact.teamMethodology.includes(teamMethodology);

                if (
                    artifact.name === 'PullRequestWithSizeGreaterThanLimit' &&
                    azureRepos
                ) {
                    status = false;
                }

                return {
                    name: artifact.name,
                    status: status,
                };
            });

            return await this.parametersService.createOrUpdateConfig(
                ParametersKey.TEAM_ARTIFACTS_CONFIG,
                teamArtifacts,
                organizationAndTeamData,
            );
        } catch (error) {
            console.log('Error saving the artifacts structure: ', error);
        }
    }

    async saveOrganizationArtifactsStructure(
        integration,
        organizationAndTeamData,
    ) {
        try {
            const teamMethodology =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                    organizationAndTeamData,
                );

            const organizationArtifactsList = organizationArtifacts.map(
                (artifact) => ({
                    name: artifact.name,
                    status: artifact.teamMethodology
                        .map((tm) => tm.toLowerCase())
                        .includes(teamMethodology.toLowerCase()),
                }),
            );

            return await this.parametersService.createOrUpdateConfig(
                ParametersKey.ORGANIZATION_ARTIFACTS_CONFIG,
                organizationArtifactsList,
                organizationAndTeamData,
            );
        } catch (error) {
            console.log(
                'Error saving organizational artifacts structure: ',
                error,
            );
        }
    }

    async saveBoardPriorityType(
        columns: any[],
        integration,
        organizationAndTeamData,
    ) {
        try {
            let priorityType = await this.definePriorityType(columns);

            // Define os níveis de prioridade
            const priorityLevels = [
                { name: 'Highest', id: '1', order: '1' },
                { name: 'High', id: '2', order: '2' },
                { name: 'Medium', id: '3', order: '3' },
                { name: 'Low', id: '4', order: '4' },
                { name: 'Lowest', id: '5', order: '5' },
            ];

            let configData;

            // Checks the priority type and constructs the appropriate configuration object
            if (priorityType === BoardPriorityType.LEXORANK_PRIORITY) {
                configData = [{ priorityType }];
            } else if (priorityType === BoardPriorityType.PRIORITY_FIELD) {
                configData = [
                    { priorityType: BoardPriorityType.PRIORITY_FIELD },
                    { priorityLevels: priorityLevels },
                ];
            }

            // Calls the service to create or update the configuration with the appropriate object
            return await this.parametersService.createOrUpdateConfig(
                ParametersKey.BOARD_PRIORITY_TYPE,
                configData,
                organizationAndTeamData,
            );
        } catch (error) {
            console.log(
                'Error saving the board priority type parameter for the team: ',
                error,
            );
        }
    }

    private async saveTeamProjectManagementMethod(
        integrationId,
        organizationAndTeamData,
        boardType,
    ) {
        const projectManagementMethod =
            boardType === 'scrum' ? 'scrum' : 'kanban';

        return await this.integrationConfigService.createOrUpdateConfig(
            IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
            projectManagementMethod,
            integrationId,
            organizationAndTeamData,
        );
    }
    //#endregion

    //#region Formatters And Mappers
    private async transformIssuesToWorkItems(
        organizationAndTeamData,
        issues,
        integrationConfig,
        integration,
        showDescription?: boolean,
    ): Promise<any> {
        const issueTypes = await this.getIssueTypes({
            organizationAndTeamData,
        });

        const issueTypesMap = new Map(
            issueTypes.map((type) => [type.id, type.untranslatedName]),
        );

        const showDescriptionConfig =
            showDescription !== undefined ? showDescription : true;

        const cards = issues
            .map((issue) => {
                const isTheSameBoard = integrationConfig?.find(
                    (status) => status.id === issue?.fields?.status?.id,
                );

                if (!isTheSameBoard) {
                    return null;
                }

                return {
                    id: issue.id,
                    key: issue.key,
                    name: issue?.fields?.summary,
                    desc: showDescriptionConfig
                        ? issue?.fields?.description || ''
                        : '',
                    changelog: issue?.changelog?.histories,
                    issueCreatedAt: issue?.fields?.created,
                    columnName: issue?.fields?.status?.name,
                    columnId: issue?.fields?.status?.id,
                    url: `${integration?.authIntegration?.authDetails?.baseUrl}/browse/${issue.key}`,
                    updated: issue?.fields?.updated,
                    created: issue?.fields?.created,
                    lastViewed: issue?.fields?.lastViewed,
                    issueType: {
                        name: issue?.fields?.issuetype?.name,
                        originalName: issueTypesMap.get(
                            issue?.fields?.issuetype?.id,
                        ),
                        id: issue?.fields?.issuetype?.id,
                        description: issue?.fields?.issuetype?.description,
                        subtask: issue?.fields?.issuetype?.subtask,
                    },
                    project: {
                        id: issue?.fields?.project?.id,
                        key: issue?.fields?.project?.key,
                        name: issue?.fields?.project?.name,
                        projectTypeKey: issue?.fields?.project?.projectTypeKey,
                    },
                    assignee: {
                        accountId: issue?.fields?.assignee?.accountId,
                        userEmail: issue?.fields?.assignee?.emailAddress,
                        userName: issue?.fields?.assignee?.displayName,
                    },
                    status: {
                        name: issue?.fields?.status?.name,
                        id: issue?.fields?.status?.id,
                        statusCategory: {
                            name: issue?.fields?.status?.statusCategory?.name,
                            id: issue?.fields?.status?.statusCategory?.id,
                        },
                    },
                    subtasks: issue?.fields?.subtasks,
                    priority: issue?.fields?.priority?.name,
                    priorityId: issue?.fields?.priority?.id,
                };
            })
            .filter(Boolean);

        return this.groupByColumn(cards);
    }

    formatDescription(description: any): string[] {
        const descriptionList = [];

        description?.content?.forEach((item) => {
            if (item.type === 'heading') {
                item.content.forEach(
                    (item_content: { type: string; text: string }) => {
                        if (item_content?.text) {
                            descriptionList.push({
                                type: item.type,
                                levelHeading: item.attrs.level,
                                content: item_content.text,
                            });
                        }
                    },
                );
            }

            if (item.type === 'paragraph') {
                item.content.forEach(
                    (item_content: { type: string; text: string }) => {
                        if (item_content?.text) {
                            descriptionList.push({
                                type: item.type,
                                content: item_content.text,
                            });
                        }
                    },
                );
            }

            if (item.type === 'bulletList') {
                const bulletList = [];

                item.content.forEach((item) => {
                    item?.content?.forEach((item_content, index: number) => {
                        if (
                            item_content?.type === 'bulletList' &&
                            item?.content[index - 1]?.type === 'paragraph'
                        ) {
                            bulletList.push({
                                title: item?.content[index - 1]?.content[0]
                                    ?.text,
                                bulletList: item_content?.content?.map(
                                    (item) =>
                                        item?.content[0]?.content[0]?.text,
                                ),
                            });
                        }
                        if (
                            item_content?.type === 'paragraph' &&
                            item?.content[index + 1]?.type !== 'bulletList'
                        ) {
                            item_content?.content?.forEach((item_content_) => {
                                if (item_content_?.text) {
                                    bulletList.push({
                                        title: item_content_?.text,
                                    });
                                }
                            });
                        }
                    });
                });

                descriptionList.push({
                    type: item.type,
                    content: bulletList,
                });
            }

            if (item.type === 'codeBlock') {
                item.content.forEach(
                    (item_content: { type: string; text: string }) => {
                        if (item_content?.text) {
                            descriptionList.push({
                                type: item.type,
                                languageCodeBlock: item.attrs.language,
                                content: item_content.text,
                            });
                        }
                    },
                );
            }

            if (item.type === 'panel') {
                descriptionList.push({
                    type: item.type,
                    panelType: item.attrs.panelType,
                    content: item.content.map(
                        (item_content: { content: { text: string }[] }) =>
                            item_content?.content[0]?.text,
                    ),
                });
            }

            if (item.type === 'rule') {
                descriptionList.push({
                    type: 'divider',
                });
            }

            if (item.type === 'expand') {
                descriptionList.push({
                    type: item.type,
                    title: item.attrs.title,
                    content: item.content.map(
                        (item_content: { content: { text: string }[] }) =>
                            item_content?.content[0]?.text,
                    ),
                });
            }

            if (item.type === 'blockquote') {
                descriptionList.push({
                    type: item.type,
                    content: item?.content?.map(
                        (item: { content: { text: string }[] }) =>
                            item?.content[0]?.text,
                    ),
                });
            }

            if (item.type === 'orderedList') {
                const orderedList = [];

                item.content.forEach((item, index) =>
                    item?.content?.forEach((item_content) => {
                        item_content?.content?.forEach((item_content_) => {
                            if (item_content_?.text) {
                                orderedList.push(
                                    `${index + 1}. ${item_content_?.text}`,
                                );
                            }
                        });
                    }),
                );

                descriptionList.push({
                    type: item.type,
                    content: orderedList,
                });
            }

            if (
                item?.type !== 'blockquote' &&
                item?.type !== 'expand' &&
                item?.type !== 'rule' &&
                item?.type !== 'panel' &&
                item?.type !== 'codeBlock' &&
                item?.type !== 'bulletList' &&
                item?.type !== 'paragraph' &&
                item?.type !== 'orderedList' &&
                item?.type !== 'heading'
            ) {
                console.log(item?.type);
            }

            // TODO - This handling is missing
            // if (item.type === 'table') {
            //     const table = [];
            //     item.content.forEach((item) =>
            //         item.content.forEach((item_content) =>
            //             item_content.content.map((item_content_) =>
            //                 table.push(item_content_?.text),
            //             ),
            //         ),
            //     );
            //     descriptionList.push({
            //         type: item.type,
            //         content: table,
            //     });
            // }

            // TODO - Check what can be done with this image information
            // if (item.type === 'mediaSingle') {
            //     item.content.map((item) => {
            //     });
            // }
        });

        return descriptionList;
    }
    //#endregion

    //#region Helpers
    private safelyParseMessageContent(messageContent) {
        try {
            // Then, parse this string back into a JavaScript object
            return JSON.parse(messageContent);
        } catch (e) {
            console.error('Error handling MessageContent:', e);
            return null;
        }
    }

    async definePriorityType(columns: any[]) {
        const priorityCount: { [priority: string]: number } = {};
        let totalItems = 0;

        // Iterate through each column and its workItems
        for (const column of columns) {
            for (const item of column.workItems) {
                const priority = item.priority;
                if (priority) {
                    // Count each priority
                    if (priorityCount[priority]) {
                        priorityCount[priority]++;
                    } else {
                        priorityCount[priority] = 1;
                    }
                    totalItems++;
                }
            }
        }

        // Define the minimum percentage to consider a priority type significant
        const significantPercentage = 0.1; // 10% of items
        const significantPriorities = Object.keys(priorityCount).filter(
            (key) => priorityCount[key] / totalItems >= significantPercentage,
        );

        const priorityType =
            significantPriorities.length >= 2
                ? BoardPriorityType.PRIORITY_FIELD
                : BoardPriorityType.LEXORANK_PRIORITY;
        return priorityType;
    }

    private groupByColumn(cards) {
        const workItems = cards.reduce((acc, card) => {
            const movements = card?.changelog?.map((log) => ({
                id: log.id,
                created: log?.created,
                movements: log?.items?.map((item) => ({
                    field: item?.field,
                    fromColumnId: item?.from,
                    fromColumnName: item?.fromString,
                    toColumnId: item?.to,
                    toColumnName: item?.toString,
                })),
            }));

            if (!acc[card.columnName]) {
                acc[card.columnName] = {
                    columnName: card?.columnName,
                    columnId: card?.columnId,
                    workItems: [],
                };
            }

            acc[card.columnName].workItems.push({
                id: card.id,
                key: card.key,
                name: card?.name,
                description: card?.desc,
                changelog: movements,
                workItemCreatedAt: card?.issueCreatedAt,
                columnName: card?.columnName,
                assignee: card?.assignee,
                workItemType: card?.issueType,
                status: card?.status,
                lexoRank: card?.lexoRank,
                priority: card?.priority,
            });

            return acc;
        }, {});

        return Object.values(workItems);
    }

    async findAndClearColumns(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.COLUMNS_MAPPING, organizationAndTeamData);

        if (integrationConfig) {
            await this.createOrUpdateColumns({
                columns: [],
                organizationAndTeamData,
            });
        }
    }

    async findAndClearBugTypes(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integrationConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                WorkItemType[]
            >(
                IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
                organizationAndTeamData,
            );

        if (integrationConfig) {
            await this.createOrUpdateBugTypes({
                workItemTypes: [],
                organizationAndTeamData,
            });
        }
    }

    async verifyConnection(
        params: any,
    ): Promise<ProjectManagementConnectionStatus> {
        if (!params.organizationAndTeamData.organizationId)
            return {
                platformName: PlatformType.JIRA,
                isSetupComplete: false,
                hasConnection: false,
                config: {},
            };

        const integration = await this.integrationService.findOne({
            organization: {
                uuid: params.organizationAndTeamData.organizationId,
            },
            team: { uuid: params.organizationAndTeamData.teamId },
            platform: PlatformType.JIRA,
            status: true,
        });

        if (!integration) {
            return {
                platformName: PlatformType.JIRA,
                isSetupComplete: false,
                hasConnection: false,
                config: { url: null },
            };
        }

        const integrationConfigColumns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(
                IntegrationConfigKey.COLUMNS_MAPPING,
                params.organizationAndTeamData,
            );

        const integrationConfigSetupConfig =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                boardId: string;
                projectId: string;
                projectKey: string;
            }>(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );

        let url = '';

        if (
            (integration?.authIntegration?.authDetails?.authToken &&
                !integrationConfigSetupConfig?.projectId &&
                !integrationConfigSetupConfig?.projectKey &&
                !integrationConfigSetupConfig?.boardId) ||
            (integration?.authIntegration?.authDetails?.isDomainUnique &&
                !integrationConfigSetupConfig?.projectId &&
                !integrationConfigSetupConfig?.projectKey)
        ) {
            url = '/jira/configuration';
        }

        if (
            integration?.authIntegration?.authDetails?.cloudId &&
            integration?.authIntegration?.authDetails?.baseUrl &&
            integrationConfigSetupConfig?.projectId &&
            integrationConfigSetupConfig?.projectKey &&
            integrationConfigSetupConfig?.boardId &&
            !integrationConfigColumns
        ) {
            url = '/jira/configuration/select-columns';
        }

        const isSetupComplete =
            integrationConfigSetupConfig?.projectId &&
            integrationConfigSetupConfig?.projectKey &&
            integration?.authIntegration?.authDetails?.cloudId &&
            integrationConfigSetupConfig?.boardId &&
            !!integrationConfigSetupConfig &&
            !!integrationConfigColumns;

        const hasConnection = url?.length > 0 || isSetupComplete;

        return {
            platformName: PlatformType.JIRA,
            isSetupComplete,
            hasConnection: !!hasConnection,
            config: { url },
            category: IntegrationCategory.PROJECT_MANAGEMENT,
        };
    }
    //#endregion

    private adjustJQL(
        jql: string,
        additionalFilters: string[],
        initializeWithAND = true,
    ): string {
        // Helper function to clean individual filters
        const cleanFilter = (filter: string): string => {
            return filter
                .replace(/%20/g, ' ') // Replace '%20' with spaces
                .replace(/%3A/gi, ':') // Replace '%3A' with ':'
                .replace(/^\s*AND\s+/i, '') // Remove 'AND' at the beginning
                .trim(); // Remove extra spaces
        };

        // 1. Replace '%20' with spaces in the initial JQL
        jql = jql.replace(/%20/g, ' ').trim();

        // 2. Remove 'project=' from the beginning, if present
        jql = jql.replace(/^project\s*=\s*[^ ]+\s*(AND\s*)?/i, '').trim();

        // 3. Extract the 'ORDER BY' clause, if it exists
        let orderBy = '';
        const orderByMatch = jql.match(/\bORDER BY\b.*$/i);
        if (orderByMatch) {
            orderBy = orderByMatch[0];
            jql = jql.replace(orderBy, '').trim();
        }

        // 4. Initialize an array to build the query parts
        const jqlParts: string[] = [];

        // 5. Add the existing JQL if it's not empty
        if (jql) {
            jqlParts.push(jql);
        }

        // 6. Clean and add additional filters
        additionalFilters.forEach((filter) => {
            if (filter && filter.trim()) {
                const cleanedFilter = cleanFilter(filter);
                if (cleanedFilter) {
                    jqlParts.push(cleanedFilter);
                }
            }
        });

        // 7. Build the query by concatenating with 'AND'
        jql = jqlParts.join(' AND ');

        // 8. Remove extra spaces
        jql = jql.replace(/\s+/g, ' ').trim();

        // 9. Add 'AND' at the beginning if necessary
        if (initializeWithAND && !jql.startsWith('AND ')) {
            jql = `AND ${jql}`;
        }

        // 10. Re-add the 'ORDER BY' clause, if it exists
        if (orderBy) {
            jql = `${jql} ${orderBy.trim()}`;
        }

        // 11. Replace spaces with '%20' for URL usage
        jql = jql.replace(/ /g, '%20');

        // 12. Ensure the query starts with '%20', if necessary
        if (initializeWithAND && !jql.startsWith('%20AND')) {
            jql = `%20${jql}`;
        }

        return jql;
    }

    private async isProjectManagementSetupFinished(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const platformConfig = await this.parametersService.findByKey(
            ParametersKey.PLATFORM_CONFIGS,
            organizationAndTeamData,
        );

        return (
            platformConfig?.configValue?.finishProjectManagementConnection ??
            false
        );
    }

    // Update the methods at the end of the class
    async getAuthUrl(): Promise<string> {
        throw new Error('Method not implemented.');
    }

    async getTeams(): Promise<any> {
        throw new Error('Method not implemented.');
    }

    async getWorkItemsByUpdatedDate(): Promise<any> {
        throw new Error('Method not implemented.');
    }
}
