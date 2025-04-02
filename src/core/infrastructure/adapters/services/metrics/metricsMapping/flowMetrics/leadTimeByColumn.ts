import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { MetricsHelper } from '../metricsHelper';
import { MetricsCategory } from '@/shared/domain/enums/metric-category.enum';
import * as moment from 'moment-timezone';

class LeadTimeByColumnMapper {
    public map(metric) {
        return {
            name: METRICS_TYPE.LEAD_TIME_BY_COLUMN,
            category: MetricsCategory.FLOW_METRICS,
            dataHistory: this.mapDataHistory(metric),
        };
    }

    private mapDataHistory(data) {
        const metricsHelper = new MetricsHelper();

        const mappedHistory = data
            .slice()
            .reverse()
            .map((entry) => {
                const initialDate = metricsHelper.calculateInitialDate(entry.date, 6);
                const finalDate = moment(entry.date).format('DD/MM/YYYY');

                return {
                    analisysInitialDate: initialDate,
                    analisysFinalDate: finalDate,
                    result: {
                        measurementType: 'hours consumed by work items in each column',
                        value: entry.original,
                    },
                };
            });

        return mappedHistory;
    }
}

export { LeadTimeByColumnMapper }
