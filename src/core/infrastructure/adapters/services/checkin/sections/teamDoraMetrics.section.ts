import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    DORA_METRICS_FACTORY_TOKEN,
    DoraMetricsConfig,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { DeployFrequencyMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/doraMetrics/deployFrequency';
import { LeadTimeForChangeMapper } from '@/core/infrastructure/adapters/services/metrics/metricsMapping/doraMetrics/leadTimeForChange';
import { MetricsVariationStatus } from '@/shared/domain/enums/metrics-variation-status.enum';
import { Inject, Injectable } from '@nestjs/common';
import { CodeManagementService } from '../../platformIntegration/codeManagement.service';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    MetricsConversionStructure,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';

@Injectable()
export class DoraMetricsCheckinSection {
    constructor(
        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private doraMetricsFactory: IDoraMetricsFactory,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    id() {
        return 'teamDoraMetrics';
    }

    name() {
        return '📊 Team DORA Metrics';
    }

    description() {
        return "Displays the team's DORA metrics, comparing current data with the previous week.";
    }

    public async execute(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const mappedMetrics = await this.getDoraMetrics(
                organizationAndTeamData,
            );

            const formattedMetrics =
                await this.formatDoraMetrics(mappedMetrics);

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: formattedMetrics,
                possibleToMutate: false,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing DORA metrics section',
                context: DoraMetricsCheckinSection.name,
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

    private async getDoraMetrics(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const mappedMetrics: any = {};
        let doraMetrics: any;

        const metricsConfig = {
            howManyMetricsInThePast: 1,
            daysInterval: 7,
            weekDay: 0,
        } as TeamMetricsConfig;

        const isGitConnected =
            await this.codeManagementService.verifyConnection({
                organizationAndTeamData,
            });

        if (!isGitConnected) {
            return {
                deployFrequency: [],
                leadTimeForChange: [],
            };
        }

        doraMetrics =
            await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                organizationAndTeamData,
                MetricsConversionStructure.METRICS_TREND,
                metricsConfig,
            );

        if (doraMetrics.deployFrequency) {
            mappedMetrics.deployFrequency = new DeployFrequencyMapper().map(
                doraMetrics.deployFrequency,
            );
        }
        if (doraMetrics.leadTimeForChange) {
            mappedMetrics.leadTimeForChange = new LeadTimeForChangeMapper().map(
                doraMetrics.leadTimeForChange,
            );
        }

        return mappedMetrics;
    }

    private formatDoraMetrics(metrics: any): any[] {
        return [
            METRICS_TYPE.DEPLOY_FREQUENCY,
            METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
        ].map((metricName) => this.formatDoraMetric(metrics[metricName]));
    }

    private formatDoraMetric(metric: any): any {
        const currentData = metric.dataHistory[0];
        const previousData = metric.dataHistory[1];

        return {
            title: this.formatTitle(metric.name),
            category: metric.category,
            currentResult: currentData.result.value,
            previousWeekResult: previousData.result.value,
            summary: this.formatSummary(currentData.resultRelatedPreviousWeek),
        };
    }

    private formatTitle(name: string): string {
        return (name.charAt(0).toUpperCase() + name
            .slice(1)
            .replace(/([A-Z])/g, ' $1')
            .trim());
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
