import { MetricsEntity } from '@/core/domain/metrics/entities/metrics.entity';
import { ThroughputCalculator } from '../../processMetrics/throughput';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { WorkItem } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

class ThroughputHistory {
    public prepareDataToBulkCreate(params: {
        workItems: WorkItem[];
        columnsConfig: ColumnsConfigResult;
        startDate: Date;
        endDate: Date;
        teamId: string;
        generateHistory: boolean;
    }): IMetrics[] {
        const throughputMetrics: IMetrics[] = [];

        const throughputCalculator = new ThroughputCalculator();

        throughputCalculator.setConfiguration(
            params.workItems,
            params.columnsConfig.doneColumns,
        );

        for (
            let currentDate = new Date(params.startDate);
            currentDate <= params.endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const dailyThroughput =
                throughputCalculator.calculateDailyThroughput(currentDate);

            if (!params.generateHistory) {
                currentDate.setDate(currentDate.getDate() + 1);
            }

            throughputMetrics.push({
                uuid: uuidv4(),
                team: { uuid: params.teamId },
                type: METRICS_TYPE.THROUGHPUT,
                value:
                    dailyThroughput.value !== 0
                        ? dailyThroughput
                        : { value: 0 },
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        }

        return throughputMetrics;
    }
}

export { ThroughputHistory };
