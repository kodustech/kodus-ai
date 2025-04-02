import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';
import { FlowMetricsResults } from '@/shared/domain/interfaces/metrics';

class LeadTimeByColumnHistory {
    public prepareDataToBulkCreate(
        metricResults: FlowMetricsResults[],
        teamId: string,
        dates: Date[],
    ): IMetrics[] {
        const allMetrics: IMetrics[] = [];

        metricResults.forEach((metricResult, index) => {
            const currentDate = dates[index];
            const leadTimeByColumn = metricResult.leadTimeByColumn;

            const totalHours = Object.values(leadTimeByColumn).reduce(
                (sum, value) => sum + value,
                0,
            );
            const totalDays = this.hoursToDays(totalHours);

            const columns = Object.entries(leadTimeByColumn).map(
                ([name, hours]) => ({
                    name,
                    hours,
                    days: this.hoursToDays(hours),
                    percentageOfTotal: this.calculatePercentage(
                        hours,
                        totalHours,
                    ),
                }),
            );

            allMetrics.push({
                uuid: uuidv4(),
                team: { uuid: teamId },
                type: METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                value: {
                    columns,
                    totalValue: {
                        hours: totalHours,
                        days: totalDays,
                    },
                },
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        });

        return allMetrics;
    }

    private hoursToDays(hours: number): number {
        return Number((hours / 24).toFixed(2));
    }

    private calculatePercentage(value: number, total: number): number {
        if (
            total === 0 ||
            isNaN(value) ||
            isNaN(total) ||
            value < 0 ||
            total < 0
        )
            return 0;
        const percentage = (value / total) * 100;
        return Math.min(100, Number(percentage.toFixed(2)));
    }
}

export { LeadTimeByColumnHistory };
