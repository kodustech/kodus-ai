import { Timezone } from '@/shared/domain/enums/timezones.enum';
import { metricsExplanation } from '@/shared/utils/metrics/metricsExplanation';
import * as moment from 'moment-timezone';

const getMetricPropertyByType = (type: string, propertyName: string) => {
    const metric = metricsExplanation.metrics.find(
        (metric) => metric.type === type,
    );

    return metric && metric[propertyName]
        ? metric[propertyName]
        : `Property or type not found`;
};

const processAndAppendMetricData = (
    resultMetricArray: any,
    data: any,
    teamName: any,
    valueExtractor: any,
    timezone = Timezone.DEFAULT_TIMEZONE
) => {
    data?.forEach((metric) => {
        let dateEntry = resultMetricArray.find((entry) =>
            moment(entry.utcDate).isSame(moment(metric.utcDate), 'day'),
        );

        if (!dateEntry) {
            dateEntry = {
                date: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('DD/MM/YYYY'),
                utcDate: metric?.utcDate,
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                teams: {},
            };
            resultMetricArray.push(dateEntry);
        }

        const value = valueExtractor(metric);
        dateEntry.teams[teamName] = value;
    });
};

const processAndAppendPlatformConnected = (
    teamsCodeManagementConfig,
    team,
    data,
) => {
    const missingConnection =
        data.hasConnection && data.config.hasRepositories === false
            ? 'repository'
            : 'codeManagement';

    teamsCodeManagementConfig.push({
        teamName: team.name,
        teamId: team.uuid,
        missingConnection,
    });
};

export {
    getMetricPropertyByType,
    processAndAppendMetricData,
    processAndAppendPlatformConnected,
};
