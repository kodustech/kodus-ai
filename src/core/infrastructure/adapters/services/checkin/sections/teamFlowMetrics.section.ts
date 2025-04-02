import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { BugRatioMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/bugRatio';
import { LeadTimeByColumnMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/leadTimeByColumn';
import { LeadTimeInWipMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/leadTimeInWip';
import { ThroughputMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/flowMetrics/throughput';
import { MetricsVariationStatus } from '@/shared/domain/enums/metrics-variation-status.enum';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '../../logger/pino.service';
import { MetricsConversionStructure } from '@/shared/domain/interfaces/metrics';
import { MetricsAnalysisInterval } from '@/shared/utils/metrics/metricsAnalysisInterval.enum';
import { generateFlowMetricsConfig } from '@/shared/utils/metrics/generateFlowMetricsConfig.utils';

@Injectable()
export class FlowMetricsCheckinSection {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN) private metricsFactory: IMetricsFactory,
        private readonly logger: PinoLoggerService,
    ) {}

    id() {
        return 'teamFlowMetrics';
    }

    name() {
        return '📈 Team Flow Metrics';
    }

    description() {
        return 'Displays the team flow metrics, comparing current data with the last week.';
    }

    public async execute(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const mappedMetrics = await this.getFlowMetrics(
                organizationAndTeamData,
            );

            const formattedMetrics =
                await this.formatFlowMetrics(mappedMetrics);

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: formattedMetrics,
                possibleToMutate: false,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing flow metrics section',
                context: FlowMetricsCheckinSection.name,
                error: error,
                metadata: { organizationAndTeamData },
            });

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: [],
                possibleToMutate: false,
            };
        }
    }

    private async getFlowMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const mappedMetrics: any = {};
        let flowMetrics: any;

        const metricsConfig = await generateFlowMetricsConfig({
            interval: MetricsAnalysisInterval.LAST_WEEK,
        });

        flowMetrics =
            await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                metricsConfig,
            );

        if (flowMetrics.bugRatio) {
            mappedMetrics.bugRatio = new BugRatioMapper().map(
                flowMetrics.bugRatio,
            );
        }

        if (flowMetrics.throughput) {
            mappedMetrics.throughput = new ThroughputMapper().map(
                flowMetrics.throughput,
            );
        }

        if (flowMetrics.leadTimeInWip) {
            mappedMetrics.leadTimeInWip = new LeadTimeInWipMapper().map(
                flowMetrics.leadTimeInWip,
            );
        }

        if (flowMetrics.leadTimeByColumn) {
            mappedMetrics.leadTimeByColumn = new LeadTimeByColumnMapper().map(
                flowMetrics.leadTimeByColumn,
            );
        }

        return mappedMetrics;
    }

    private async formatFlowMetrics(metrics: any): Promise<any[]> {
        return [
            METRICS_TYPE.BUG_RATIO,
            METRICS_TYPE.THROUGHPUT,
            METRICS_TYPE.LEAD_TIME_IN_WIP,
        ].map((metricName) => this.formatFlowMetric(metrics[metricName]));
    }

    private formatFlowMetric(metric: any): any {
        const currentData = metric.dataHistory[0];
        const previousData = metric.dataHistory[1];

        return {
            title: this.formatTitle(metric.name),
            category: metric.category,
            currentResult: this.formatResult(currentData.result),
            previousWeekResult: this.formatResult(previousData.result),
            summary: this.formatSummary(currentData.resultRelatedPreviousWeek),
        };
    }

    private formatTitle(name: string): string {
        return (name.charAt(0).toUpperCase() + name
            .slice(1)
            .replace(/([A-Z])/g, ' $1')
            .trim());
    }

    private formatResult(result: any): string {
        if (typeof result.value === 'number') {
            return result.value.toFixed(2).toString();
        }
        return result.value;
    }

    private formatSummary(resultRelatedPreviousWeek: any): string {
        if (!resultRelatedPreviousWeek)
            return 'Insufficient data for comparison';
        const { variation, type } = resultRelatedPreviousWeek;
        switch (type) {
            case MetricsVariationStatus.IMPROVES:
                return `Improvement of ${variation}`;
            case MetricsVariationStatus.WORSENS:
                return `Worsening of ${variation}`;
            case MetricsVariationStatus.NEUTRAL:
                return 'Result remained the same';
            default:
                return 'Comparison unavailable';
        }
    }
}
