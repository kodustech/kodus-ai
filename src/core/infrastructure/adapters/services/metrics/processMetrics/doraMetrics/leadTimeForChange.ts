import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import { CommitLeadTimeForChange } from '@/core/domain/platformIntegrations/types/codeManagement/commitLeadTimeForChange.type';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import { LeadTimeForChangeFormat } from '@/shared/utils/formatters/leadTimeForChange';

import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

class LeadTimeForChangeCalculator {
    private commitLeadTimeForChange: CommitLeadTimeForChange[];
    private analysisPeriod: {
        startTime: Date;
        endTime: Date;
    };

    setConfiguration(
        commitLeadTimeForChange: CommitLeadTimeForChange[],
        analysisPeriod: {
            startTime: Date;
            endTime: Date;
        },
    ) {
        this.commitLeadTimeForChange = commitLeadTimeForChange;
        this.analysisPeriod = analysisPeriod;
    }

    async calculateLeadTimeForChanges() {
        const leadTimes = this.commitLeadTimeForChange?.map((deploy) => {
            const commitDate = moment(deploy.commit.commit.author.date);
            const lastDeployDate = moment(deploy.lastDeploy.created_at);

            return lastDeployDate.diff(commitDate, 'hours', true);
        });

        const total = leadTimes?.reduce((acc, cur) => acc + cur, 0);
        const average = total / leadTimes.length;
        const sortedLeadTimes = [...leadTimes].sort((a, b) => a - b);
        const p50 = this.calculatePercentile(sortedLeadTimes, 50);
        const p75 = this.calculatePercentile(sortedLeadTimes, 75);
        const p95 = this.calculatePercentile(sortedLeadTimes, 95);

        return {
            total: total,
            average: average,
            percentiles: {
                p50: p50,
                p75: p75,
                p95: p95,
            },
        };
    }

    private calculatePercentile(leadTimeOrdered, percentil): number {
        const result = (leadTimeOrdered.length - 1) * (percentil / 100);

        const resultFloor = Math.floor(result);

        if (resultFloor + 1 < leadTimeOrdered.length) {
            return (
                leadTimeOrdered[resultFloor] +
                (result - resultFloor) *
                    (leadTimeOrdered[resultFloor + 1] -
                        leadTimeOrdered[resultFloor])
            );
        }

        return leadTimeOrdered[result];
    }

    calculateAverageCompanyLeadTimeForChange(
        leadTimeForChangeMetrics: IOrganizationMetrics[],
    ): number {
        const leadTimeForChangeValues: number[] = [];

        for (const metric of leadTimeForChangeMetrics) {
            leadTimeForChangeValues.push(metric.value.average);
        }

        const sum = leadTimeForChangeValues.reduce((a, b) => a + b, 0);
        return Math.round(sum / leadTimeForChangeValues.length);
    }

    processAndAppendLeadTimeForChanges(
        deployFrequencyResult,
        deployFrequencyData,
        teamName,
    ) {
        return processAndAppendMetricData(
            deployFrequencyResult,
            deployFrequencyData,
            teamName,
            (metric) => metric.original.percentiles?.p75 / 24,
        );
    }

    formatLeadTimeForChangesTeamAndPeriod(
        data: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        return data.map((metric, index) => {
            const value = metric.original.percentiles?.p75
                ? metric.original.percentiles.p75 / 24
                : null;

            return {
                date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YYYY'),
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                value,
                order: index + 1,
            };
        });
    }

    calculateAverageOrganizationLeadTimeForChange(leadTimeForChange: any) {
        const leadTimeForChangeByDate = {};

        leadTimeForChange.forEach((item) => {
            const normalizedDate = moment(item.date).format('YYYY-MM-DD');

            if (!leadTimeForChangeByDate[normalizedDate]) {
                leadTimeForChangeByDate[normalizedDate] = {
                    average: 0,
                    total: 0,
                    count: 0,
                };
            }

            leadTimeForChangeByDate[normalizedDate].average +=
                item.original.average * item.original.total;

            leadTimeForChangeByDate[normalizedDate].total +=
                item.original.total;

            leadTimeForChangeByDate[normalizedDate].count++;
        });

        const results = Object.keys(leadTimeForChangeByDate).map(
            (date, index) => {
                const data = leadTimeForChangeByDate[date];
                const weightedAverage = data.average / data.total;

                return {
                    date: moment(date).format('DD/MM/YYYY'),
                    value: weightedAverage / 24,
                    order: index + 1,
                };
            },
        );

        return results.sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );
    }

    processLeadTimeForChangesForCockpit(data: any) {
        const { leadTimeForChange } = data || {};

        if (leadTimeForChange?.length > 1) {
            const recent = leadTimeForChange[1]?.original?.percentiles?.p75;
            const previous = leadTimeForChange[0]?.original?.percentiles?.p75;

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
                name: METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
                title: 'Lead Time For Change',
                result: LeadTimeForChangeFormat(recent),
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : recent > previous
                          ? 'Negative'
                          : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    leadTimeForChange[0]?.metricType,
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType(
                    leadTimeForChange[0]?.metricType,
                    'whatIsIt',
                ),
                layoutIndex: 2,
            };
        }
    }
}

export { LeadTimeForChangeCalculator };
