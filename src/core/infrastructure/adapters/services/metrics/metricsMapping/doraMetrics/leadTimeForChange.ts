import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import { MetricsHelper } from '../metricsHelper';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import * as moment from 'moment-timezone';

class LeadTimeForChangeMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
            category: MetricsCategory.DORA_METRICS,
            dataHistory: this.mapDataHistory(
                metric,
                'number of days from first commit to PR closing',
                true,
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

                let resultRelatedPreviousWeek;
                if (index < array.length - 1) {
                    const previousEntry = array[index + 1];
                    resultRelatedPreviousWeek =
                        metricsHelper.calculateVariation(
                            Math.round(entry.original.percentiles.p75 / 24),
                            Math.round(
                                previousEntry.original.percentiles.p75 / 24,
                            ),
                            isInverted,
                        );
                }

                return {
                    analisysInitialDate: initialDate,
                    analisysFinalDate: finalDate,
                    result: {
                        value: Math.round(entry.original.percentiles.p75 / 24),
                        measurementType: measurementType,
                    },
                    resultRelatedPreviousWeek: resultRelatedPreviousWeek,
                };
            });

        return mappedHistory;
    }
}

export { LeadTimeForChangeMapper };
