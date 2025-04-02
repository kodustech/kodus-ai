import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { Inject, Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { MetricTrendAnalyzerAndFormatter } from '../../../../metrics/processMetrics/metricAnalyzerAndFormatter';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetTeamMetricsTool',
    tool_description:
        'Captures a comprehensive set of real-time team performance metrics, including Throughput, Lead Time, and Bug Ratio, to offer a broad view of team efficiency, productivity, and quality. Comparison with historical data enables trend identification and data-driven decision-making for process improvements.',
    tool_signals_to_choose:
        'Recommended when seeking an aggregated view of team performance, with metrics reflecting overall efficiency, productivity, and quality, facilitating comparison with past periods to assess progress and identify areas for improvement.',
    tool_parameters: {
        parameter_metricType: {
            parameter_metricTypes_example:
                '{"types": ["LeadTime", "LeadTimeBreakdown"...]}',
            parameter_metricType_enum: JSON.stringify([
                'leadTime',
                'cycleTime',
                'leadTimeInWip',
                'leadTimeByColumn',
                'throughput',
                'bugRatio',
                'leadTimeInWipByItemType',
                'leadTimeByItemType',
            ]),
            parameter_metricType_required: false,
            parameter_metricType_description:
                'Type of metric filter, one of the enums or empty.',
            parameter_metricType_observation:
                'If parameter is null it will return all last metrics.',
        },
    },
    tool_data_return_structure: {
        metrics: [
            {
                metricType: 'string',
                date: 'string',
                original: {},
                difference: {},
                description: 'string',
            },
        ],
    },
};

@Injectable()
export class GetTeamMetricsTool implements ITool<any, IToolResult> {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetTeamMetricsTool.name;
    }

    get description(): string {
        return 'Get metrics (e.g., lead time, on track, etc.)';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const metrics: any = {};

            const operation = input?.parameters?.parameter_metricType;

            const operationParameters = this.formatOperationType(operation);

            const metricTrendAnalyzerAndFormatter =
                new MetricTrendAnalyzerAndFormatter();

            const metricsHistoric =
                await this.metricsFactory.getRealTimeAndHistoricalMetrics(
                    context.organizationAndTeamData,
                );

            if (
                Array.isArray(operationParameters) &&
                operationParameters.length === 0
            ) {
                Object.values(METRICS_TYPE).forEach((type) => {
                    metrics[type] =
                        metricTrendAnalyzerAndFormatter.getLastMetricByType(
                            type,
                            metricsHistoric,
                        );
                });
            } else {
                operationParameters.forEach((param) => {
                    const metricsTypeMap = Object.values(METRICS_TYPE).reduce(
                        (map, metricType) => {
                            map[metricType.toLowerCase()] = metricType;
                            return map;
                        },
                        {},
                    );

                    if (param.toLowerCase() === 'cycletime') {
                        param = 'leadtimeinwip';
                    }

                    if (param.toLowerCase() in metricsTypeMap) {
                        const originalMetricType =
                            metricsTypeMap[param.toLowerCase()];

                        const metric =
                            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                                originalMetricType,
                                metricsHistoric,
                            );

                        metrics[originalMetricType] = metric;
                    }
                });
            }

            // Deleting metrics that do not require analysis, to keep the object lightweight
            delete metrics?.leadTime?.original?.issues;
            delete metrics?.leadTimeInWip?.original?.issues;
            delete metrics?.leadTime?.differences[0]?.original?.issues;
            delete metrics?.leadTime?.differences[0]?.difference?.issues;
            delete metrics?.leadTimeInWip?.differences[0]?.original?.issues;
            delete metrics?.leadTimeInWip?.differences[0]?.difference?.issues;

            return {
                stringResult: this.formatReturnToPrompt(metrics),
                jsonResult: {
                    metrics,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Team Metrics Tool',
                context: GetTeamMetricsTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Team Metrics Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(metrics: any): string {
        return `Team Agile and Engineering Metrics: ${this.generateMetricsNarrative(metrics)}`;
    }

    private formatOperationType(operation: string) {
        if (!operation) {
            return [];
        }

        const operationJSON = JSON.parse(operation);

        return operationJSON?.types || [];
    }

    private generateMetricsNarrative(metrics: any) {
        let narrative = '';

        if (metrics[METRICS_TYPE.LEAD_TIME]) {
            narrative += this.formatLeadTime(metrics[METRICS_TYPE.LEAD_TIME]);
        }
        if (metrics[METRICS_TYPE.LEAD_TIME_IN_WIP]) {
            narrative += this.formatLeadTimeInWip(
                metrics[METRICS_TYPE.LEAD_TIME_IN_WIP],
            );
        }
        if (metrics[METRICS_TYPE.BUG_RATIO]) {
            narrative += this.formatBugRatio(metrics[METRICS_TYPE.BUG_RATIO]);
        }
        if (metrics[METRICS_TYPE.THROUGHPUT]) {
            narrative += this.formatThroughput(
                metrics[METRICS_TYPE.THROUGHPUT],
            );
        }

        if (metrics[METRICS_TYPE.LEAD_TIME_BY_COLUMN]) {
            narrative += this.formatLeadTimeByColumn(
                metrics[METRICS_TYPE.LEAD_TIME_BY_COLUMN],
            );
        }

        // If there are no metrics to format, return a default message
        return narrative.length > 0
            ? narrative
            : 'No metrics data available to generate narrative.\n';
    }

    private formatLeadTime(leadTime): string {
        if (leadTime.length === 0) {
            return 'No current or previous data available for leadtime metrics';
        }

        let metricOutput = `\n * Current LeadTime in P75 [${leadTime.date}] (${leadTime.description}): ${leadTime.original.total.percentiles.p75} - Previous LeadTime results:`;

        if (leadTime.differences.length === 0) {
            metricOutput += `No previous data available for leadtime metrics`;
        }

        for (const previousLeadTime of leadTime.differences) {
            metricOutput += `${previousLeadTime.date}: Value ${previousLeadTime.original.total.percentiles.p75} Difference ${previousLeadTime.difference.total.percentiles.p75} | `;
        }

        return metricOutput + '\n';
    }
    private formatLeadTimeInWip(leadTimeInWip): string {
        if (leadTimeInWip.length === 0) {
            return 'No current or previous data available for leadTimeInWip metrics';
        }

        let metricOutput = `\n * Current LeadTimeInWip In Wip in P75 [${leadTimeInWip.date}] (${leadTimeInWip.description}): ${leadTimeInWip.original.total.percentiles.p75} - Previous leadTimeInWip results:`;

        if (leadTimeInWip.differences.length === 0) {
            metricOutput += `No previous data available for leadTimeInWip metrics`;
        }

        for (const previousLeadTime of leadTimeInWip.differences) {
            metricOutput += `${previousLeadTime.date}: Value ${previousLeadTime.original.total.percentiles.p75} Difference ${previousLeadTime.difference.total.percentiles.p75} | `;
        }

        return metricOutput + '\n';
    }
    private formatBugRatio(bugRatio): string {
        if (bugRatio.length === 0) {
            return 'No current or previous data available for bugRatio metrics';
        }

        let metricOutput = `\n * Current BugRatio for the last 7 days [${bugRatio.date}] (${bugRatio.description}): ${(bugRatio.original.value * 100).toFixed(0)}% - Previous bugRatio results:`;

        if (bugRatio.differences.length === 0) {
            metricOutput += `No previous data available for bugRatio metrics`;
        }

        for (const previousLeadTime of bugRatio.differences) {
            metricOutput += `${previousLeadTime.date}: Value ${(previousLeadTime.original.value * 100).toFixed(0)}% Difference ${previousLeadTime.difference.value} | `;
        }

        return metricOutput + '\n';
    }
    private formatThroughput(throughput): string {
        if (throughput.length === 0) {
            return 'No current or previous data available for throughput metrics';
        }

        let metricOutput = `\n * Current Throughput for the last 7 days [${throughput.date}] (${throughput.description}): ${throughput.original.value} - Previous throughput results:`;

        if (throughput.differences.length === 0) {
            metricOutput += `No previous data available for throughput metrics`;
        }

        for (const previousLeadTime of throughput.differences) {
            metricOutput += `${previousLeadTime.date}: Value ${previousLeadTime.original.value} Difference ${previousLeadTime.difference.value} | `;
        }

        return metricOutput;
    }

    private formatLeadTimeByColumn(leadTimeByColumn): string {
        if (leadTimeByColumn.length === 0) {
            return 'No current or previous data available for leadTimeByColumn metrics';
        }

        let result = '';

        Object.entries(leadTimeByColumn.original).forEach(
            ([column, duration]) => {
                result += `Column: ${column} ${duration}\n\n`;
            },
        );

        let metricOutput = `\n * Current Throughput for the last 7 days [${leadTimeByColumn.date}] (${leadTimeByColumn.description}): ${result} - Previous leadTimeByColumn results:`;

        if (leadTimeByColumn.differences.length === 0) {
            metricOutput += `No previous data available for leadTimeByColumn metrics`;
        }

        for (const previousLeadTime of leadTimeByColumn.differences) {
            let resultDifference = '';
            let resultOrigin = '';

            Object.entries(previousLeadTime.difference).forEach(
                ([column, duration]) => {
                    resultDifference += `Column: ${column} ${duration}\n\n`;
                },
            );

            Object.entries(previousLeadTime.original).forEach(
                ([column, duration]) => {
                    resultOrigin += `Column: ${column} ${duration}\n\n`;
                },
            );

            metricOutput += `${previousLeadTime.date}: Original Value ${resultOrigin} Difference Value ${resultDifference} | `;
        }

        return metricOutput;
    }
}
