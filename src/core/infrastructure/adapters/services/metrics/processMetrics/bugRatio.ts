import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import { BugRatio } from '@/shared/domain/interfaces/metrics';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import { shouldProcessNotBugItems } from '@/shared/utils/helpers';
import { calculatePercentagePointDifference } from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

class BugRatioCalculator {
    private payload: any[];
    private wipColumns: any[];
    private bugTypeIdentifiers: any;

    setConfiguration(
        payload: any[],
        wipColumns: any[],
        bugTypeIdentifiers: any,
    ) {
        this.payload = payload;
        this.wipColumns = wipColumns;
        this.bugTypeIdentifiers = bugTypeIdentifiers;
    }

    /**
     * Calculates the bug ratio based on the total number of bugs and issues.
     *
     * @return {number} The bug ratio as a decimal value.
     */
    calculateBugRatioForAll(): BugRatio {
        let totalBugs = 0;
        let totalIssuesInWip = 0;

        for (const column of this.payload) {
            for (const workItem of column.workItems) {
                // Exit the loop if the issue is not in WIP
                if (!this.wipColumns.includes(workItem.status.id)) continue;

                // Count all issues
                totalIssuesInWip++;

                // Check if the Work Item is in the list of items mapped as bugs for the team
                if (
                    shouldProcessNotBugItems(
                        workItem?.workItemType?.name,
                        this.bugTypeIdentifiers,
                    )
                ) {
                    totalBugs++;
                }
            }
        }

        // Calculate the bug ratio
        // Check if totalIssuesInWip is zero to avoid division by zero
        const bugRatio =
            totalIssuesInWip > 0 ? totalBugs / totalIssuesInWip : 0;

        return {
            value: Number(bugRatio.toFixed(3)),
            totalWorkItems: totalIssuesInWip,
            totalBugs: totalBugs,
        };
    }

    calculateAverageCompanyBugRatio(
        bugRatioMetrics: IOrganizationMetrics[],
    ): number {
        const bugRatioValues: number[] = [];

        for (const metric of bugRatioMetrics) {
            if (metric?.value?.value !== undefined) {
                bugRatioValues.push(metric.value.value);
            } else if (metric?.value !== undefined) {
                bugRatioValues.push(metric.value);
            } else {
                bugRatioValues.push(0);
            }
        }

        const sum = bugRatioValues.reduce((a, b) => a + b, 0);
        return Math.round((sum / bugRatioValues.length) * 100);
    }

    processAndAppendBugRatio(bugRatioResult, bugRatioData, teamName) {
        return processAndAppendMetricData(
            bugRatioResult,
            bugRatioData,
            teamName,
            (metric) => metric.original.value,
        );
    }

    formatBugRatioTeamAndPeriod(
        data: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        return data.map((metric, index) => ({
            date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YY'),
            chartDate: moment(metric?.utcDate)
                .tz(timezone)
                .format('YYYY-MM-DD'),
            value: metric.original.value,
            order: index + 1,
        }));
    }

    processBugRatioForCockpit(rawData) {
        const bugRatio = rawData.bugRatio;

        if (bugRatio.length > 1) {
            const recent = bugRatio[1].original.value;
            const previous = bugRatio[0].original.value;

            let percentageDifference = '';
            let realDifference;

            percentageDifference = calculatePercentagePointDifference(
                previous,
                recent,
            );
            realDifference = calculatePercentagePointDifference(
                previous,
                recent,
            );

            const result = recent * 100;
            return {
                name: METRICS_TYPE.BUG_RATIO,
                title: 'Bug Ratio',
                result: result.toFixed(2).toString() + '%',
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : recent > previous
                          ? 'Negative'
                          : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    'bugRatio',
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType('bugRatio', 'whatIsIt'),
                layoutIndex: 3,
            };
        }
    }
}

export { BugRatioCalculator };
