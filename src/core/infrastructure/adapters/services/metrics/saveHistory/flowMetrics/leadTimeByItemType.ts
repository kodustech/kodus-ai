import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';
import { FlowMetricsResults } from '@/shared/domain/interfaces/metrics';

class LeadTimeByItemTypeHistory {
    public prepareDataToBulkCreate(
        metricResults: FlowMetricsResults[],
        teamId: string,
        dates: Date[],
    ): IMetrics[] {
        const allMetrics: IMetrics[] = [];

        metricResults.forEach((metricResult, index) => {
            const currentDate = dates[index];

            // LeadTimeByItemType
            allMetrics.push({
                uuid: uuidv4(),
                team: { uuid: teamId },
                type: METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE,
                value: metricResult.leadTimeByItemType,
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);

            // LeadTimeInWipByItemType
            allMetrics.push({
                uuid: uuidv4(),
                team: { uuid: teamId },
                type: METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE,
                value: metricResult.leadTimeInWipByItemType,
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        });

        return allMetrics;
    }
}

export { LeadTimeByItemTypeHistory };
