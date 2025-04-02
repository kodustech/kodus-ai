import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { MetricsHelper } from '../metricsHelper';
import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import * as moment from 'moment-timezone';

class LeadTimeInWipMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.LEAD_TIME_IN_WIP,
            category: MetricsCategory.FLOW_METRICS,
            dataHistory: this.mapDataHistory(metric, '75th percentile of hours spent on wip', true),
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
                        value: entry.original.total.percentiles.p75,
                        measurementType: measurementType,
                    },
                    resultRelatedPreviousWeek: previousEntry
                        ? metricsHelper.calculateVariation(
                              entry.original.total.percentiles.p75,
                              previousEntry.original.total.percentiles.p75,
                              isInverted,
                          )
                        : undefined,
                    percentiles: {
                        p50: {
                            value: entry.original.total.percentiles.p50,
                            variation: previousEntry
                                ? metricsHelper.calculateVariation(
                                      entry.original.total.percentiles.p50,
                                      previousEntry.original.total.percentiles.p50,
                                      isInverted,
                                  )
                                : undefined,
                        },
                        p75: {
                            value: entry.original.total.percentiles.p75,
                            variation: previousEntry
                                ? metricsHelper.calculateVariation(
                                      entry.original.total.percentiles.p75,
                                      previousEntry.original.total.percentiles.p75,
                                      isInverted,
                                  )
                                : undefined,
                        },
                        p95: {
                            value: entry.original.total.percentiles.p95,
                            variation: previousEntry
                                ? metricsHelper.calculateVariation(
                                      entry.original.total.percentiles.p95,
                                      previousEntry.original.total.percentiles.p95,
                                      isInverted,
                                  )
                                : undefined,
                        },
                    },
                };
            });

        return mappedHistory;
    }
}

export { LeadTimeInWipMapper }
