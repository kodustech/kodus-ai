import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { STRING_TIME_INTERVAL } from '@/core/domain/integrationConfigs/enums/stringTimeInterval.enum';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetWorkItensTool',
    tool_description:
        'Retrieves work items based on selected criteria, such as current state (in progress), time frame (week, last 24 hours) or by type, providing extensive details for each item.',
    tool_signals_to_choose:
        'Use this tool in the following situations: (1) Tracking Work Item Progress: When you need to monitor the status of work items, including tasks, bugs, and stories, across different stages like To Do, In Progress, and Done. (2) Workload Analysis: To analyze the distribution of work among team members, including what items are currently assigned to specific individuals. (3) Sprint Planning and Retrospective: For assessing the completion and backlog of work items in a sprint or during sprint reviews. (4) Work Item Details: To get detailed information about specific work items, including their description, assignee, and related history. (5) Understanding Task Breakdown: To see how tasks and subtasks are organized and their current status. (6) Monitoring Specific Issues: To track the progress and resolution of particular issues or enhancements in the project.',

    tool_parameters: {
        parameter_workItemsIds: {
            parameter_workItemsIds_example:
                '{"workItemsIds": ["GE-18", "KDZ-20", "NT-10", "HYPER-44", "APP-538"]}',
            parameter_workItemsIds_required: false,
            parameter_workItemsIds_description:
                "Array of work item IDs, obtained directly from the user's message.",
        },
        parameter_columnFilter: {
            parameter_columnFilter_example: '"InWIP | InDone | ToDo | All"',
            parameter_columnFilter_required: true,
            parameter_columnFilter_enum: ['InWIP', 'InDone', 'ToDo', 'All'],
            parameter_columnFilter_description:
                'Type of column filter, one of the enums.',
        },
        parameter_timeFilter: {
            parameter_timeFilter_example: '"12H | 1D | 7D | 14D | 30D"',
            parameter_timeFilter_required: false,
            parameter_timeFilter_enum: ['12H', '1D', '7D', '14D', '30D'],
            parameter_timeFilter_description:
                'Type of time filter, one of the enums.',
        },
        parameter_expandChangelog: {
            parameter_expandChangelog_required: false,
            parameter_expandChangelog_description:
                'Expand the changelog information if set to true. Use this when you need to analyze the movement of a task, such as how long it stayed in a column or you need to undestand dates deeply, for example date that task is completed or is started. This is very expensive to use, especially when used with the DataAnalyst tool. Use it with caution.',
            parameter_expandChangelog_example: 'false | true',
            parameter_expandChangelog_default: 'false',
        },
        parameter_showDescription: {
            parameter_showDescription_required: false,
            parameter_showDescription_description:
                'Include task descriptions in the output if set to true. **Set this to true when you need to analyze or extract information from the task descriptions**, such as when implementing or integrating with tools like the ConversationCodeBase tool. **Default is true.**',
            parameter_showDescription_example: 'false | true',
            parameter_showDescription_default: 'true',
        },
        parameter_assigneeFilter: {
            parameter_assigneeFilter_required: false,
            parameter_assigneeFilter_description:
                'Filter tasks by the assignee. Provide an array of names or email addresses of the people responsible for the tasks.',
            parameter_assigneeFilter_example:
                '["John Doe", "jane.doe@example.com"]',
        },
    },
    tool_data_return_structure: {
        workItems: [
            {
                key: 'string',
                id: 'string',
                name: 'string',
                description: 'string',
                created: 'string',
                updated: 'string',
                changelog: [
                    {
                        id: 'string',
                        createdAt: 'string',
                        movements: [
                            {
                                field: 'string',
                                fromColumnId: 'string',
                                fromColumnName: 'string',
                                toColumnId: 'string',
                                toColumnName: 'string',
                            },
                        ],
                    },
                ],
                workItemCreatedAt: 'string',
                columnName: 'string',
                priority: 'string',
                flagged: 'boolean',
                assignee: {
                    accountId: 'string',
                    userName: 'string',
                },
                workItemType: {
                    name: 'string',
                    id: 'string',
                    description: 'string',
                    subtask: 'boolean',
                },
                status: {
                    name: 'string',
                    id: 'string',
                    statusCategory: {
                        name: 'string',
                        id: 'number',
                    },
                },
            },
        ],
    },
};

export class GetWorkItensTool implements ITool<any, IToolResult> {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetWorkItensTool.name;
    }

    get description(): string {
        return 'Get work itens by keys or ids passed as parameters. Return this structure: {WorkItems: [{"key":"string","id":"string","name":"string","description":"string","created":"string","updated":"string","changelog":[{"id":"string","createdAt":"string","movements":[{"field":"string","fromColumnId":"string","fromColumnName":"string","toColumnId":"string","toColumnName":"string"}]}],"workItemCreatedAt":"string","columnName":"string","priority":"string","flagged":"boolean","assignee":{"accountId":"string","userName":"string"},"workItemType":{"name":"string","id":"string","description":"string","subtask":"boolean"},"status":{"name":"string","id":"string","statusCategory":{"name":"string","id":"number"}}}]}';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const columnsFilter = input?.parameters?.parameter_columnFilter;
            const timeFilter = input?.parameters?.parameter_timeFilter;
            const showDescription =
                input?.parameters?.parameter_showDescription || false;
            const expandChangelog =
                input?.parameters?.parameter_expandChangelog || false;
            const assigneeFilters =
                input?.parameters?.parameter_assigneeFilter || [];

            const workItemsIds = input?.parameters?.parameter_workItemsIds
                ? JSON.parse(input.parameters.parameter_workItemsIds)
                      .workItemsIds
                : [];

            let weekTasks = [];

            const columnsConfig: ColumnsConfigResult =
                await this.projectManagementService.getColumnsConfig(
                    context.organizationAndTeamData,
                );

            let filters = this.setFilteredColumns(columnsFilter, columnsConfig);

            const workItemTypesDefault =
                await this.projectManagementService.getWorkItemsTypes(
                    context.organizationAndTeamData,
                    MODULE_WORKITEMS_TYPES.DEFAULT,
                );

            weekTasks =
                await this.projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
                    {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        filters: {
                            statusesIds: filters?.filteredColumns,
                            movementFilter: (item) =>
                                item.field !== 'description',
                            workItemsIds:
                                workItemsIds && workItemsIds.length > 0
                                    ? workItemsIds
                                    : undefined,
                            stringTimeInterval:
                                this.setTimeIntervalFilter(timeFilter),
                            workItemTypes: workItemTypesDefault,
                            expandChangelog: expandChangelog,
                            showDescription: showDescription,
                            assigneeFilter: assigneeFilters
                                ? this.secureParse(assigneeFilters)
                                : [],
                        },
                    },
                );

            return {
                stringResult: this.formatReturnToPrompt(
                    weekTasks,
                    columnsConfig,
                ),
                jsonResult: {
                    weekTasks,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Work Items Tool',
                context: GetWorkItensTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Work Items Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(
        weekTasks: Item[],
        columnsConfig: ColumnsConfigResult,
    ): string {
        return `Board Configuration For This Team:
            To Do Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'todo'))}\n
            WIP (Work In Progress Columns): ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'wip'))}\n
            Done Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'done'))}\n

            Work Items.: ${weekTasks ? JSON.stringify(this.generateWorkItemsNarrative(weekTasks, columnsConfig)) : ''}`;
    }

    private generateWorkItemsNarrative(
        workItems: Item[],
        columnsConfig: ColumnsConfigResult,
    ) {
        if (!workItems || workItems?.length <= 0) {
            return '[]';
        }

        return workItems.map((workItem) => {
            const filteredColumnConfig = this.getActualColumnsConfigByWorkItem(
                workItem,
                columnsConfig,
            );

            let changelog;
            if (workItem.changelog && workItem.changelog.length > 0) {
                changelog = workItem.changelog
                    .map((change) =>
                        change.movements
                            .filter(
                                (field) =>
                                    field.field !== 'description' &&
                                    field.field !== 'Rank',
                            )
                            .map((movement) => ({
                                ...movement,
                                dateOfChange: change.createdAt,
                            })),
                    )
                    .filter((item) => item.length > 0);
            }

            return `Work Item Name: ${workItem.name} \n  Work Item Description: ${
                workItem.description?.content
                    ? workItem.description.content
                    : workItem.description
                      ? workItem.description
                      : 'Description not found'
            } \n KEY: ${workItem.key}
              \n Flagged (It means that there is some blockage/impediment that should be given attention): ${workItem.flagged}
              \n Assignee: ${workItem?.assignee?.userName}
              \n Actual Column Name: ${workItem.columnName}
              \n Actual Column ID: ${workItem.status.id}
              \n Actual Status: ${workItem.status.name}
              \n Column Config (Information about the column the item currently belongs to): ${JSON.stringify(filteredColumnConfig)}
              \n CreatedAt: ${workItem.workItemCreatedAt}
              \n DeliveredAt: ${workItem?.workItemDeliveredAt ? workItem.workItemDeliveredAt : 'Não entregue'}
              \n Changelog (WorkItem History): ${changelog ? JSON.stringify(changelog) : ''}`;
        });
    }

    private getActualColumnsConfigByWorkItem(
        workItem: Item,
        columnsConfig: ColumnsConfigResult,
    ): any {
        return columnsConfig.allColumns.filter(
            (columnConfig: ColumnsConfigKey) =>
                columnConfig.id === workItem.status.id,
        );
    }

    private setFilteredColumns(workOperationTypeParameters, columnsConfig) {
        if (!workOperationTypeParameters) {
            return null;
        }

        const operation = this.secureParse(workOperationTypeParameters);

        if (operation.includes('InWIP')) {
            return {
                filteredColumns: columnsConfig?.allColumns
                    ?.filter(
                        (columnConfig: ColumnsConfigKey) =>
                            columnConfig.column === 'wip',
                    )
                    ?.map((columnConfig) => columnConfig.id),
            };
        } else if (operation.includes('InDone')) {
            return {
                filteredColumns: columnsConfig?.allColumns
                    ?.filter(
                        (columnConfig: ColumnsConfigKey) =>
                            columnConfig.column === 'done',
                    )
                    ?.map((columnConfig) => columnConfig.id),
            };
        } else if (operation.includes('ToDo')) {
            return {
                filteredColumns: columnsConfig?.allColumns
                    ?.filter(
                        (columnConfig: ColumnsConfigKey) =>
                            columnConfig.column === 'todo',
                    )
                    ?.map((columnConfig) => columnConfig.id),
            };
        } else {
            return {
                filteredColumns: columnsConfig?.allColumns?.map(
                    (columnConfig) => columnConfig.id,
                ),
            };
        }
    }

    private setTimeIntervalFilter(parameterTimeFilter) {
        if (!parameterTimeFilter) {
            return null;
        }

        const timeFilter = this.secureParse(parameterTimeFilter);
        if (timeFilter.includes('21D')) {
            return STRING_TIME_INTERVAL.LAST_21_DAYS;
        } else if (timeFilter.includes('20D')) {
            return STRING_TIME_INTERVAL.LAST_20_DAYS;
        } else if (timeFilter.includes('14D')) {
            return STRING_TIME_INTERVAL.LAST_14_DAYS;
        } else if (timeFilter.includes('7D')) {
            return STRING_TIME_INTERVAL.LAST_7_DAYS;
        } else if (timeFilter.includes('2D')) {
            return STRING_TIME_INTERVAL.LAST_48_HOURS;
        } else if (timeFilter.includes('1D')) {
            return STRING_TIME_INTERVAL.LAST_24_HOURS;
        } else if (timeFilter.includes('12H')) {
            return STRING_TIME_INTERVAL.LAST_12_HOURS;
        } else {
            return STRING_TIME_INTERVAL.LAST_1_MONTH;
        }
    }

    private secureParse(value: any) {
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
    }
}
