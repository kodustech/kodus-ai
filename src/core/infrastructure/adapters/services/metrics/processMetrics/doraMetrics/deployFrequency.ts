import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import {
    getDayForFilter,
    getDaysBetweenDates,
    getWeeksBetweenDates,
} from '@/shared/utils/transforms/date';
import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

export type DeployFrequencyConfigurationData = {
    deployFrequencyData?: DeployFrequency[];
    analysisPeriod?: {
        startTime: Date;
        endTime: Date;
    };
};

class DeployFrequencyCalculator {
    private deployFrequencyData: DeployFrequency[];
    private analysisPeriod: {
        startTime: Date;
        endTime: Date;
    };

    setConfiguration(config: DeployFrequencyConfigurationData) {
        this.deployFrequencyData = config?.deployFrequencyData;
        this.analysisPeriod = config?.analysisPeriod;
    }

    calculateDeployFrequency(generateHistory?: boolean): any {
        const weeksBetween = getWeeksBetweenDates(
            this.analysisPeriod.startTime,
            this.analysisPeriod.endTime,
        );
        const daysBetween = getDaysBetweenDates(
            this.analysisPeriod.startTime,
            this.analysisPeriod.endTime,
        );

        const totalDeployments = this.deployFrequencyData?.length || 0;

        const dailyFrequency =
            totalDeployments > 0
                ? parseFloat((totalDeployments / daysBetween).toFixed(2))
                : 0;
        const weeklyFrequency =
            totalDeployments > 0
                ? parseFloat((totalDeployments / weeksBetween).toFixed(2))
                : 0;

        const deployFrequencyData = {
            deploymentsLastWeek: generateHistory
                ? this.getLasWeekReleasesCount(this?.analysisPeriod?.endTime)
                : this.getLasWeekReleasesCount(),
            deploymentsTotal: totalDeployments,
            dailyFrequency: dailyFrequency,
            weeklyFrequency: weeklyFrequency,
        };

        return deployFrequencyData;
    }

    private getLasWeekReleasesCount(endDate?: Date): number {
        const { today, dateAfterDaysInformed } = endDate
            ? getDayForFilter(7, endDate)
            : getDayForFilter(7);

        const result = this.deployFrequencyData?.filter((release) => {
            const releaseDate = new Date(release.created_at).toISOString();

            if (
                releaseDate >= new Date(dateAfterDaysInformed).toISOString() &&
                releaseDate <= new Date(today).toISOString()
            ) {
                return release;
            }
        });

        return result?.length || 0;
    }

    calculateAverageWeeklyFrequencyCompanyDeployFrequency(
        deployFrequencyMetrics: IOrganizationMetrics[],
    ): number {
        if (
            !this.analysisPeriod ||
            !this.analysisPeriod.startTime ||
            !this.analysisPeriod.endTime
        ) {
            const endDate = new Date();
            const startDate = new Date(endDate);
            startDate.setDate(startDate.getDate() - 90); // Default to 90 days
            this.analysisPeriod = {
                startTime: startDate,
                endTime: endDate,
            };
        }

        const weeksBetween = getWeeksBetweenDates(
            this.analysisPeriod.startTime,
            this.analysisPeriod.endTime,
        );

        if (weeksBetween <= 0) {
            return 0;
        }

        const deployFrequencyValues: number[] = [];

        for (const metric of deployFrequencyMetrics) {
            if (
                metric &&
                metric.value &&
                typeof metric.value.deploymentsTotal === 'number'
            ) {
                deployFrequencyValues.push(metric.value.deploymentsTotal);
            }
        }

        const sum = deployFrequencyValues.reduce((a, b) => a + b, 0);
        const result = Number((sum / weeksBetween).toFixed(2));

        return result;
    }

    calculateAverageOrganizationDeployFrequency(allFrequencies: any) {
        const frequencyByDate = {};
        const weeksBetween = getWeeksBetweenDates(
            this.analysisPeriod.startTime,
            this.analysisPeriod.endTime,
        );
        const daysBetween = getDaysBetweenDates(
            this.analysisPeriod.startTime,
            this.analysisPeriod.endTime,
        );

        allFrequencies.forEach((item) => {
            const normalizedDate = moment(item.date).format('YYYY-MM-DD');

            if (!frequencyByDate[normalizedDate]) {
                frequencyByDate[normalizedDate] = {
                    dailyFrequency: 0,
                    weeklyFrequency: 0,
                    deploymentsTotal: 0,
                    deploymentsLastWeek: 0,
                    count: 0,
                };
            }

            frequencyByDate[normalizedDate].dailyFrequency +=
                item.original.dailyFrequency;
            frequencyByDate[normalizedDate].weeklyFrequency +=
                item.original.weeklyFrequency;
            frequencyByDate[normalizedDate].deploymentsTotal +=
                item.original.deploymentsTotal;
            frequencyByDate[normalizedDate].deploymentsLastWeek +=
                item.original.deploymentsLastWeek;
            frequencyByDate[normalizedDate].count++;
        });

        const results = Object.keys(frequencyByDate).map((date, index) => {
            const data = frequencyByDate[date];

            const dailyFrequency =
                data.deploymentsTotal > 0
                    ? parseFloat(
                        (data.deploymentsTotal / daysBetween).toFixed(2),
                    )
                    : 0;

            const weeklyFrequency =
                data.deploymentsTotal > 0
                    ? parseFloat(
                        (data.deploymentsTotal / weeksBetween).toFixed(2),
                    )
                    : 0;

            return {
                date: moment(date).format('DD/MM/YYYY'),
                value: {
                    dailyFrequency,
                    weeklyFrequency,
                    deploymentsTotal: data.deploymentsTotal,
                    deploymentsLastWeek: data.deploymentsLastWeek,
                },
                order: index + 1,
            };
        });

        return results.sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );
    }

    setAnalysisPeriod(period: { startTime: Date; endTime: Date }) {
        this.analysisPeriod = period;
    }

    processAndAppendDeployFrequency(
        deployFrequencyResult,
        deployFrequencyData,
        teamName,
    ) {
        return processAndAppendMetricData(
            deployFrequencyResult,
            deployFrequencyData,
            teamName,
            (metric) => metric?.original,
        );
    }

    formatDeployFrequencyTeamAndPeriod(data: any, timezone = Timezone.DEFAULT_TIMEZONE) {
        return data.map((metric, index) => ({
            date: moment(metric.utcDate)
                .tz(timezone)
                .format('DD/MM/YYYY'),
            value: metric.original,
            order: index + 1,
        }));
    }

    processDeployFrequencyForCockpit(data: any) {
        const deployFrequency = data?.deployFrequency;

        if (deployFrequency?.length > 1) {
            const recent = deployFrequency[1].original?.weeklyFrequency;
            const previous = deployFrequency[0].original?.weeklyFrequency;
            let percentageDifference = '';
            let realDifference;

            percentageDifference = calculatePercentageDifference(
                previous,
                recent,
            ).percentageDifference;
            realDifference = calculatePercentageDifference(
                previous,
                recent,
            ).realDifference;

            return {
                name: METRICS_TYPE.DEPLOY_FREQUENCY,
                title: 'Deploy Frequency',
                result: recent?.toString(),
                resultObs: 'deploys/week',
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : previous > recent
                            ? 'Negative'
                            : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    'deployFrequency',
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType(
                    'deployFrequency',
                    'whatIsIt',
                ),
                layoutIndex: 1,
            };
        }
    }
}

export { DeployFrequencyCalculator };
