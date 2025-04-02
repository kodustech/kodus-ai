import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { Inject, Injectable } from '@nestjs/common';
import * as moment from 'moment-timezone';
import { PromptService } from '../prompt.service';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { ICheckinInsightsService } from '@/core/domain/checkins/contracts/checkinInsights.service.contract';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    MetricTrend,
    MetricTrendAnalyzerAndFormatter,
} from '../metrics/processMetrics/metricAnalyzerAndFormatter';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

@Injectable()
export class CheckinInsightsService implements ICheckinInsightsService {
    constructor(
        private readonly promptService: PromptService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,
    ) {}

    async getInsightsForOffTrackItems(
        organizationAndTeamData,
        workItems,
        metrics,
        wipColumns,
    ) {
        const workItemsOffTrack =
            await this.prepareWorkItemsOffTracks(workItems);

        const fomattedMetrics = await this.formatMetricsDataToInsights(metrics);

        const llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_TURBO,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const payload = `Below is the information required for your analysis. Team metrics history: ${JSON.stringify(fomattedMetrics)}, Team board column ordering: ${JSON.stringify(wipColumns)}, and here are the overdue work items for you to generate insights: ${JSON.stringify(workItemsOffTrack)};`;

        const promptInsights =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_checkin_insightsForOverdueWorkItems',
                {
                    organizationAndTeamData,
                    promptIsForChat: false,
                    payload: payload,
                },
            );

        const insights = await safelyParseMessageContent(
            (
                await llm.invoke(promptInsights, {
                    metadata: {
                        submodule: 'GenerateInsightsForCheckin',
                        module: 'AutomationTeamProgress',
                        teamId: organizationAndTeamData.teamId,
                    },
                })
            ).content,
        ).insights;

        return insights;
    }

    private async prepareWorkItemsOffTracks(workItems) {
        const workItemsOffTrack = workItems.map((item) => ({
            key: item.key,
            title: item.title,
            description: item.description,
            estimatedDeliveryDate: moment(item.estimatedDeliveryDate).format(
                'DD/MM/YYYY',
            ),
            timeAlreadyUsed: item.leadTimeUsed,
            timeAlreadyUsedFormatted: item.leadTimeUsedFormatted,
            workItemType: item.type?.name,
            responsibleDeveloper: item?.assignedTo,
            dateEnteredIntoWip: moment(
                new Date(
                    new Date().getTime() - item.leadTimeUsed * 60 * 60 * 1000,
                ),
            ).format('DD/MM/YYYY'),
            actualColumn: item.actualStatus,
            rank: item.rank,
        }));

        return workItemsOffTrack;
    }

    private async formatMetricsDataToInsights(metrics: any) {
        const bugRatio = metrics.bugRatio.differences.map((metric) => ({
            startDate: moment(metric.date)
                .clone()
                .subtract(7, 'days')
                .format('DD/MM/YYYY'),
            endDate: moment(metric.date).format('DD/MM/YYYY'),
            value: metric.original.value,
        }));

        const leadTimeInWip = metrics.leadTimeInWip.differences.map(
            (metric) => ({
                startDate: moment(metric.date)
                    .clone()
                    .subtract(7, 'days')
                    .format('DD/MM/YYYY'),
                endDate: moment(metric.date).format('DD/MM/YYYY'),
                value: metric.original.total.percentiles.p75,
            }),
        );

        const throughput = metrics.throughput.differences.map((metric) => ({
            startDate: moment(metric.date)
                .clone()
                .subtract(7, 'days')
                .format('DD/MM/YYYY'),
            endDate: moment(metric.date).format('DD/MM/YYYY'),
            value: metric.original.value,
        }));

        return { bugRatio, leadTimeInWip, throughput };
    }

    async getMetricsDataToInsights(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const metricTrendAnalyzerAndFormatter =
            new MetricTrendAnalyzerAndFormatter();

        const metricsHistoric =
            await this.metricsFactory.getRealTimeAndHistoricalMetrics(
                organizationAndTeamData,
            );

        if (!metricsHistoric) {
            return 'No metrics found';
        }

        const bugRatio: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.BUG_RATIO,
                metricsHistoric,
            );

        const leadTime: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.LEAD_TIME,
                metricsHistoric,
            )?.original;

        const throughput: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.THROUGHPUT,
                metricsHistoric,
            );

        const leadTimeInWip: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.LEAD_TIME_IN_WIP,
                metricsHistoric,
            );

        const leadTimeByColumn: MetricTrend =
            metricTrendAnalyzerAndFormatter.getLastMetricByType(
                METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                metricsHistoric,
            )?.original;

        return {
            leadTimeByColumn,
            leadTime,
            leadTimeInWip,
            throughput,
            bugRatio,
        };
    }
}
