import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { WorkItem } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { DeliveryCapacityCalculator } from '../../processMetrics/deliveryCapacity';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';

interface ThroughputData {
    value: number;
    referenceDate: string;
}

class DeliveryCapacityHistory {
    public prepareDataToBulkCreate(params: {
        workItems: WorkItem[];
        columnsConfig: ColumnsConfigResult;
        startDate: Date;
        endDate: Date;
        teamId: string;
        generateHistory: boolean;
        throughputData: ThroughputData[];
    }): IMetrics[] {
        const deliveryCapacityMetrics: IMetrics[] = [];

        const calculator = new DeliveryCapacityCalculator();
        calculator.setConfiguration(
            params.workItems,
            params.columnsConfig.todoColumns,
            params.throughputData,
        );

        for (
            let currentDate = new Date(params.startDate);
            currentDate <= params.endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const dailyDeliveryCapacity =
                calculator.calculateDeliveryCapacity(currentDate);

            if (!params.generateHistory) {
                currentDate.setDate(currentDate.getDate() + 1);
            }

            deliveryCapacityMetrics.push({
                uuid: uuidv4(),
                team: { uuid: params.teamId },
                type: METRICS_TYPE.DELIVERY_CAPACITY,
                value: dailyDeliveryCapacity,
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        }

        return deliveryCapacityMetrics;
    }
}

export { DeliveryCapacityHistory };
