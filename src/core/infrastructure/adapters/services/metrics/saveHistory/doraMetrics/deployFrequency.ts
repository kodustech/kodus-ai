import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { DeployFrequencyCalculator } from '../../processMetrics/doraMetrics/deployFrequency';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';

class DeployFrequencyHistory {
    public prepareDataToBulkCreate(params: {
        deployFrequencyData: DeployFrequency[];
        startDate: Date;
        endDate: Date;
        teamId: string;
    }): IMetrics[] {
        const deployFrequencyMetrics: IMetrics[] = [];
        const deployFrequencyCalculator = new DeployFrequencyCalculator();

        if (
            !params?.deployFrequencyData ||
            params?.deployFrequencyData?.length <= 0
        ) {
            return;
        }

        for (
            let currentDate = new Date(params.startDate);
            currentDate <= params.endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const endOfDay = new Date(currentDate);
            endOfDay.setHours(23, 59, 59, 999);

            const dailyDeployFrequencyData =
                params?.deployFrequencyData?.filter(
                    (deploy) => new Date(deploy.created_at) <= endOfDay,
                );

            deployFrequencyCalculator.setConfiguration({
                deployFrequencyData: dailyDeployFrequencyData,
                analysisPeriod: {
                    startTime: new Date(
                        params.startDate.getTime() - 7 * 24 * 60 * 60 * 1000,
                    ),
                    endTime: endOfDay,
                },
            });

            const dailyDeployFrequency =
                deployFrequencyCalculator.calculateDeployFrequency(true);

            deployFrequencyMetrics.push({
                uuid: uuidv4(),
                team: { uuid: params.teamId },
                type: METRICS_TYPE.DEPLOY_FREQUENCY,
                value: dailyDeployFrequency,
                status: true,
                category: METRICS_CATEGORY.DORA_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        }

        return deployFrequencyMetrics;
    }
}

export { DeployFrequencyHistory };
