import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { MetricsHelper } from '../metricsHelper';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import * as moment from 'moment-timezone';

class ThroughputMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.THROUGHPUT,
            category: MetricsCategory.FLOW_METRICS,
            dataHistory: this.mapDataHistory(metric, 'done work items', false),
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
                        value:
                            entry.original.value !== undefined
                                ? entry.original.value
                                : entry.original.total.value !== undefined
                                  ? entry.original.total.value
                                  : 0,
                        measurementType: measurementType,
                    },
                    resultRelatedPreviousWeek: previousEntry
                        ? metricsHelper.calculateVariation(
                              entry.original.value !== undefined
                                  ? entry.original.value
                                  : entry.original.total.value !== undefined
                                    ? entry.original.total.value
                                    : 0,
                              previousEntry.original.value !== undefined
                                  ? previousEntry.original.value
                                  : previousEntry.original.total.value !==
                                      undefined
                                    ? previousEntry.original.total.value
                                    : 0,
                              isInverted,
                          )
                        : undefined,
                };
            });

        return mappedHistory;
    }
}

export { ThroughputMapper };
