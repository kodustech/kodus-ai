import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { MetricsHelper } from '../metricsHelper';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import * as moment from 'moment-timezone';

class BugRatioMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.BUG_RATIO,
            category: MetricsCategory.FLOW_METRICS,
            dataHistory: this.mapDataHistory(metric, 'percentage: bugs in wip vs number of tasks in wip', true),
        };
    }

    private mapDataHistory(data, measurementType, isInverted) {
        const metricsHelper = new MetricsHelper();
        const mappedHistory = data
            .slice()
            .reverse()
            .map((entry, index, array) => {
                const initialDate = metricsHelper.calculateInitialDate(
                    entry.date,
                    6,
                );
                const finalDate = moment(entry.date).format('DD/MM/YYYY');
                const previousEntry = array[index + 1];

                return {
                    analisysInitialDate: initialDate,
                    analisysFinalDate: finalDate,
                    result: {
                        value: `${(entry.original.value * 100).toFixed(2)}%`,
                        measurementType: measurementType,
                    },
                    resultRelatedPreviousWeek: previousEntry
                        ? metricsHelper.calculateVariation(
                              entry.original.value,
                              previousEntry.original.value,
                              isInverted,
                          )
                        : undefined,
                };
            });

        return mappedHistory;
    }
}

export { BugRatioMapper }
