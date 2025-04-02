import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { MetricTrendAnalyzerAndFormatter } from '../../../../metrics/processMetrics/metricAnalyzerAndFormatter';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    'tool_name': 'GetDeliveryEstimationForWorkItemsTool',
    'tool_description':
        'Provides forecasts for delivery dates and current aging of work items, using statistical estimations (p50, p75, p95) to offer a range of probable delivery timelines. This tool helps in planning and risk assessment by predicting when work items are likely to be completed.',
    'tool_signals_to_choose':
        'Use this tool when you need to forecast delivery dates for work items or assess their current aging, to aid in project planning and management.',
    'tool_parameters': [
        {
            parameter_workItemsIds: {
                parameters_workItemsIds_example:
                    '{"workItemsIds": ["KC-123", "KL-123", ...]}',
                required: false,
                parameter_workItemsIds_description:
                    "Array of work item IDs, obtained directly from the user's message or from the GetWorkItemsTool, remember parameters_workItemsIds_example is an example of how the user can pass via chat",
            },
        },
    ],
    'tool_data_return_structure': {
        workItemsWithEstimations: [
            {
                key: 'string',
                startDate: 'string (in DD/MM/YYYY format)',
                aging: 'number in days',
                p50: {
                    estimationDate: 'string (in DD/MM/YYYY format)',
                    isLate: 'boolean',
                },
                p75: {
                    estimationDate: 'string (in DD/MM/YYYY format)',
                    isLate: 'boolean',
                },
                p95: {
                    estimationDate: 'string (in DD/MM/YYYY format)',
                    isLate: 'boolean',
                },
            },
        ],
    },
    'tool_requirements:':
        "Requires an array of work item IDs, obtained directly from the user's message or from the GetWorkItemsTool.",
};

@Injectable()
export class GetDeliveryEstimationForWorkItemsTool
    implements ITool<any, IToolResult>
{
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetDeliveryEstimationForWorkItemsTool.name;
    }

    get description(): string {
        return 'Get delivery estimation for work items (e.g., 3 days)';
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

            const workItemsIds = this.extractWorkItemsIds(
                input?.parameters?.parameter_workItemsIds,
                weekTasksParams,
            );

            if (!workItemsIds || workItemsIds.length <= 0) {
                return {
                    stringResult: '',
                    jsonResult: {},
                };
            }

            const workItems =
                await this.projectManagementService.getWorkItemsById({
                    workItems: workItemsIds,
                    organizationAndTeamData: context.organizationAndTeamData,
                    filters: {
                        expandChangelog: true,
                    },
                });

            if (!workItems || workItems?.length <= 0) {
                return {
                    stringResult: '',
                    jsonResult: {},
                };
            }

            const metricTrendAnalyzerAndFormatter =
                new MetricTrendAnalyzerAndFormatter();

            const metricsHistoric =
                await this.metricsFactory.getRealTimeAndHistoricalMetrics(
                    context.organizationAndTeamData,
                );

            const leadTimeInWip =
                metricTrendAnalyzerAndFormatter.getLastMetricByType(
                    METRICS_TYPE.LEAD_TIME_IN_WIP,
                    metricsHistoric,
                ).original.total.percentiles;

            const workItemsEstimation =
                await this.metricsFactory.estimateWorkItems(
                    context.organizationAndTeamData,
                    leadTimeInWip,
                    workItems,
                );

            return {
                stringResult: this.formatReturnToPrompt(workItemsEstimation),
                jsonResult: {
                    workItemsEstimation,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Delivery Estimation Tool',
                context: GetDeliveryEstimationForWorkItemsTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing GetDeliveryEstimationForWorkItemsTool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(workItemsEstimation: any): string {
        if (!workItemsEstimation || workItemsEstimation?.length <= 0) {
            return 'Unable to find information for this item';
        }

        const workItemsEstimationFormatted = workItemsEstimation.map(
            (workItem) => {
                return {
                    key: workItem.key,
                    estimationDate: workItem.p75?.estimationDate,
                    isLate: workItem.p75?.isLate,
                    daysLateDelivery: workItem.p75?.daysLateDelivery,
                    noteAboutEstimation: workItem.p75?.noteAboutEstimation,
                    aging: workItem.aging,
                    message: workItem.message,
                };
            },
        );

        return `Delivery estimation for tasks in board: ${JSON.stringify(
            workItemsEstimationFormatted,
        )}`;
    }

    private extractWorkItemsIds(
        parameterWorkItems: any,
        weekTasksParams: any,
    ): string[] {
        if (!parameterWorkItems || weekTasksParams) {
            return [];
        }

        if (Array.isArray(parameterWorkItems)) {
            return parameterWorkItems;
        }

        if (typeof parameterWorkItems === 'string') {
            try {
                const parsed = JSON.parse(parameterWorkItems);
                return Array.isArray(parsed?.workItemsIds)
                    ? parsed.workItemsIds
                    : [];
            } catch (error) {
                this.logger.error({
                    message: 'Failed to parse parameter_workItemsIds',
                    context: GetDeliveryEstimationForWorkItemsTool.name,
                    error: error,
                });
                return [];
            }
        }

        return [];
    }
}
