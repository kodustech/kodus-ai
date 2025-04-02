import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { MetricsHelper } from '../metricsHelper';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import * as moment from 'moment-timezone';

class DeployFrequencyMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.DEPLOY_FREQUENCY,
            category: MetricsCategory.DORA_METRICS,
            dataHistory: this.mapDataHistory(
                metric,
                'weekly deployments frequency',
                false,
            ),
        };
    }

    private mapDataHistory(data, measurementType, isInverted) {
        const metricsHelper = new MetricsHelper();

        const mappedHistory = data
            .slice()
            .reverse()
            .map((entry, index, array) => {
                const initialDate = metricsHelper.calculateInitialDate(
                    entry.utcDate,
                    6,
                );
                const finalDate = moment(entry.utcDate).format('DD/MM/YYYY');
                const weeklyFrequency = entry.original.weeklyFrequency;
                const previousEntry = array[index + 1];
                const previousWeeklyFrequency = previousEntry
                    ? previousEntry.original.weeklyFrequency
                    : null;

                return {
                    analisysInitialDate: initialDate,
                    analisysFinalDate: finalDate,
                    result: {
                        value: weeklyFrequency,
                        measurementType: measurementType,
                    },
                    resultRelatedPreviousWeek: previousEntry
                        ? metricsHelper.calculateVariation(
                              weeklyFrequency,
                              previousWeeklyFrequency,
                              isInverted,
                          )
                        : undefined,
                };
            });

        return mappedHistory;
    }
}

export { DeployFrequencyMapper };
