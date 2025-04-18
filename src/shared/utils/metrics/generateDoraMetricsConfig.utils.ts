import { DoraMetricsConfig } from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { MetricsAnalysisInterval } from './metricsAnalysisInterval.enum';

async function calculateStartDate(
    interval: MetricsAnalysisInterval,
): Promise<Date> {
    const today = new Date();

    switch (interval) {
        case MetricsAnalysisInterval.LAST_WEEK:
            return new Date(today.setDate(today.getDate() - 7));

        case MetricsAnalysisInterval.LAST_TWO_WEEKS:
            return new Date(today.setDate(today.getDate() - 14));

        case MetricsAnalysisInterval.LAST_MONTH:
            return new Date(today.setDate(today.getDate() - 30));

        case MetricsAnalysisInterval.LAST_THREE_MONTHS:
            return new Date(today.setDate(today.getDate() - 90));

        default:
            return today;
    }
}

export async function generateDoraMetricsConfig(params: {
    startDate?: string;
    endDate?: string;
    interval?: MetricsAnalysisInterval;
}): Promise<DoraMetricsConfig> {
    const currentDate = new Date();
    const defaultEndDate = params.endDate
        ? new Date(params.endDate)
        : new Date(new Date().setDate(new Date().getDate() - 1));

    const defaultStartDate = params.interval
        ? calculateStartDate(params.interval)
        : params.startDate
          ? new Date(params.startDate)
          : new Date(currentDate.setDate(currentDate.getDate() - 90));

    return {
        weekDay: 0,
        daysInterval: 7,
        checkConnectionByOneTeam: false,
        analysisPeriod: {
            startTime: await defaultStartDate,
            endTime: defaultEndDate,
        },
    };
}
