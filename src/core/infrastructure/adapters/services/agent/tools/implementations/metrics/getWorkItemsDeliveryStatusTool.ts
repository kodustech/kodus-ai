import { Inject, Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import {
    Item,
    ItemWithDeliveryStatus,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { PinoLoggerService } from '../../../../logger/pino.service';
import { GetWorkItemTypesTool } from '../projectManagement/getWorkItemTypesTool';

const toolDefinition = {
    tool_name: 'GetWorkItemsDeliveryStatusTool',
    tool_description:
        'Provides the current delivery status of specific work items, highlighting whether they are delayed or on schedule. This tool is crucial for monitoring the timeliness of individual tasks and time utilization, offering detailed visibility into the progress of each work item.',
    tool_signals_to_choose:
        'Ideal when a detailed analysis of the delivery status of specific work items is needed, including timeliness and efficiency in time usage for each task.',
    tool_parameters: [
        {
            parameter_workItemsIds: {
                parameters_workItemsIds_example:
                    '{"workItemsIds": ["KC-123", "KL-123"...]}',
                required: false,
                parameter_workItemsIds_description:
                    "Array of work item IDs, obtained directly from the user's message or from the GetWorkItemsTool",
            },
        },
    ],
    tool_data_return_structure: {
        deliveryStatusForWorkItems: [
            {
                id: 'string',
                key: 'string',
                title: 'string',
                actualStatus: 'string',
                assignedTo: 'string',
                leadTimeToEnd: 'number',
                leadTimeUsed: 'number',
                percentageLeadTimeAlreadyUsed: 'number',
                leadTimeToEndWithLeadTimeAlreadyUsed: 'number',
                percentageLeadTimeExceeded: 'number',
                isLate: 'boolean',
                onTrackFlag: 'string',
            },
        ],
    },
    tool_requirements:
        "Requires an array of work item IDs, obtained directly from the user's message or from the GetWorkItemsTool.",
};

@Injectable()
export class GetWorkItemsDeliveryStatusTool implements ITool<any, IToolResult> {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetWorkItemsDeliveryStatusTool.name;
    }

    get description(): string {
        return 'Get the delivery status (whether late or on track) for work items. Return this structure: {{"workItemsWithDeliveryStatus": [{"id": "string", "key": "string", "title": "string", "actualStatus": "string", "assignedTo": "string", "leadTimeToEnd": "number", "leadTimeUsed": "number", "percentageLeadTimeAlreadyUsed": "number", "leadTimeToEndWithLeadTimeAlreadyUsed": "number", "percentageLeadTimeExceeded": "number", "isLate": "boolean", "onTrackFlag": "string"}]}}\n GetWorkItemsDeliveryStatusTool: This function need a get workItem function before.';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const weekTasksParams =
                input?.parameters?.GetWorkItensTool?.weekTasks;

            let workItemsIds = [];
            if (input?.parameters?.parameter_workItemsIds && !weekTasksParams) {
                try {
                    const parsedInput = JSON.parse(
                        input.parameters.parameter_workItemsIds,
                    );
                    if (
                        parsedInput &&
                        Array.isArray(parsedInput.workItemsIds)
                    ) {
                        workItemsIds = parsedInput.workItemsIds;
                    }
                } catch (error) {
                    this.logger.log({
                        message:
                            'Error converting parameter_workItemsIds to JSON',
                        context: GetWorkItemsDeliveryStatusTool.name,
                        error: error,
                        metadata: {
                            teamId: context.organizationAndTeamData.teamId,
                            organizationId:
                                context.organizationAndTeamData.organizationId,
                        },
                    });
                }
            }

            const columnsConfig: ColumnsConfigResult =
                await this.projectManagementService.getColumnsConfig(
                    context.organizationAndTeamData,
                );

            const filteredColumns = columnsConfig.allColumns.map(
                (columnConfig) => columnConfig.id,
            );

            let weekTasks = [];

            const workItemTypesDefault =
                await this.projectManagementService.getWorkItemsTypes(
                    context.organizationAndTeamData,
                    MODULE_WORKITEMS_TYPES.DEFAULT,
                );

            if (weekTasks && weekTasks.length > 0) {
                weekTasks = weekTasksParams;
            } else if (workItemsIds) {
                weekTasks =
                    await this.projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
                        {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            filters: {
                                statusesIds: filteredColumns,
                                movementFilter: (item) =>
                                    item.field !== 'description',
                                workItemsIds:
                                    workItemsIds && workItemsIds.length > 0
                                        ? workItemsIds
                                        : undefined,
                                workItemTypes: workItemTypesDefault,
                                expandChangelog: true,
                            },
                        },
                    );
            }

            const metrics = await this.metricsFactory.getRealTime(
                context.organizationAndTeamData,
            );

            const teamMethodology =
                await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                    IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                    context.organizationAndTeamData,
                );

            const workItemsWithDeliveryStatus =
                await this.metricsFactory.getWorkItemsDeliveryStatus(
                    context.organizationAndTeamData,
                    weekTasks,
                    metrics,
                    columnsConfig,
                    teamMethodology,
                );

            return {
                stringResult: this.formatReturnToPrompt(
                    workItemsWithDeliveryStatus,
                ),
                jsonResult: {
                    workItemsWithDeliveryStatus,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Work Items Delivery Status Tool',
                context: GetWorkItemsDeliveryStatusTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing GGetWorkItemsDeliveryStatusTool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(weekTasks: ItemWithDeliveryStatus[]): string {
        return `Delivery status for tasks in board: ${
            weekTasks ? JSON.stringify(weekTasks) : ''
        }`;
    }
}
