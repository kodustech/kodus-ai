import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';
import { LeadTimeForChangeCalculator } from '../../processMetrics/doraMetrics/leadTimeForChange';

class LeadTimeForChangeHistory {
    public async prepareDataToBulkCreate(params: {
        commitLeadTimeForChangeData: CommitLeadTimeForChange[];
        startDate: Date;
        endDate: Date;
        teamId: string;
    }): Promise<IMetrics[]> {
        const leadTimeForChangeMetrics: IMetrics[] = [];
        const leadTimeForChangeCalculator = new LeadTimeForChangeCalculator();

        if (
            !params?.commitLeadTimeForChangeData ||
            params?.commitLeadTimeForChangeData?.length <= 0
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

            const dailyCommitData = params?.commitLeadTimeForChangeData?.filter(
                (commit) => new Date(commit.lastDeploy.created_at) <= endOfDay,
            );

            leadTimeForChangeCalculator.setConfiguration(dailyCommitData, {
                startTime: params.startDate,
                endTime: endOfDay,
            });

            const dailyLeadTimeForChange =
                await leadTimeForChangeCalculator.calculateLeadTimeForChanges();

            leadTimeForChangeMetrics.push({
                uuid: uuidv4(),
                team: { uuid: params.teamId },
                type: METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
                value: dailyLeadTimeForChange,
                status: true,
                category: METRICS_CATEGORY.DORA_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        }

        return leadTimeForChangeMetrics;
    }
}

export { LeadTimeForChangeHistory };
