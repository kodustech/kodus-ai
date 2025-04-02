import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { LeadTimeCalculator } from './leadTime';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import * as moment from 'moment-timezone';
import { LeadTimeFormat } from '@/shared/utils/formatters/leadTime';
import { Timezone } from '@/shared/domain/enums/timezones.enum';

/**
 * @class LeadTimeInWipCalculator
 * Responsible for calculating the cycle time of a process.
 */
class LeadTimeInWipCalculator {
    private changelog: any[];
    private columnsConfig: any;
    private workItemCreatedAt: Date;
    private todayDate?: Date;

    setConfiguration(
        changelog: any[],
        columnsConfig: ColumnsConfigResult,
        workItemCreatedAt: Date,
        todayDate?: Date,
    ) {
        this.changelog = changelog;
        this.columnsConfig = columnsConfig;
        this.workItemCreatedAt = workItemCreatedAt;
        this.todayDate = todayDate;
    }

    /**
     * Calculates the Lead Time in WIP (Work In Progress) of a process.
     *
     * @return {number | undefined} The Lead Time in WIP in number of units, or undefined if the calculation is not possible.
     */
    public calculateLeadTimeInWip(): number | undefined {
        // Instantiates a LeadTimeCalculator object with the necessary configurations,
        // including the changelog, column configuration, a boolean indicating whether
        const leadTimeCalculator = new LeadTimeCalculator();
        leadTimeCalculator.setConfiguration(
            this.changelog,
            this.columnsConfig,
            true,
            this.workItemCreatedAt,
            this.todayDate,
        );

        // Calculates the lead times for all columns and stores the results.
        const leadTimes = leadTimeCalculator.calculateLeadTime().leadTimes;

        // Initializes the total lead time in "WIP" as 0.
        let totalLeadTimeInWip = 0;

        // Iterates over the IDs of the "WIP" columns specified in the `wipColumns` array
        // within the `columnsConfig` object. For each "WIP" column ID, finds the corresponding
        // column name and sums the recorded lead time for it.
        this.columnsConfig.wipColumns.forEach((wipColumnId) => {
            const wipColumn = this.columnsConfig.allColumns.find(
                (column) => column.id === wipColumnId,
            );
            if (wipColumn && leadTimes[wipColumn.name] !== undefined) {
                // Adds the lead time of the current "WIP" column to the total.
                totalLeadTimeInWip += leadTimes[wipColumn.name];
            }
        });

        // Returns the total lead time in "WIP". If the total is greater than 0, returns the calculated value;
        // otherwise, returns undefined, indicating that no lead time is recorded in "WIP" columns.
        return totalLeadTimeInWip > 0
            ? Number(totalLeadTimeInWip.toFixed(3))
            : undefined;
    }

    calculateAverageCompanyLeadTimeInWip(
        leadTimeInWipMetrics: IOrganizationMetrics[],
    ): number {
        const leadTimeInWipValues: number[] = [];

        for (const metric of leadTimeInWipMetrics) {
            leadTimeInWipValues.push(metric.value?.total?.percentiles?.p75);
        }

        const sum = leadTimeInWipValues.reduce((a, b) => a + b, 0);
        return Math.round(sum / leadTimeInWipValues.length);
    }

    processAndAppendLeadTimeInWip(
        leadTimeInWipResult,
        leadTimeInWipData,
        teamName,
    ) {
        return processAndAppendMetricData(
            leadTimeInWipResult,
            leadTimeInWipData,
            teamName,
            (metric) => metric.original.total.percentiles?.p75 / 24,
        );
    }

    formatLeadTimeInWipForTeamAndPeriod(
        data: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        return data.map((metric, index) => {
            const value = metric.original.total.percentiles?.p75
                ? metric.original.total.percentiles.p75 / 24
                : null;
            return {
                date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YY'),
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                value,
                order: index + 1,
            };
        });
    }

    processLeadTimeDataForCockpit(data) {
        const leadTimeInWip = data.leadTimeInWip;

        if (leadTimeInWip.length > 1) {
            const recent = leadTimeInWip[1].original.total.percentiles.p75;
            const previous = leadTimeInWip[0].original.total.percentiles.p75;
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
                name: METRICS_TYPE.LEAD_TIME_IN_WIP,
                title: 'Lead Time in WIP',
                result: LeadTimeFormat(recent),
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : recent > previous
                          ? 'Negative'
                          : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    leadTimeInWip[0].metricType,
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType(
                    leadTimeInWip[0].metricType,
                    'whatIsIt',
                ),
                layoutIndex: 1,
            };
        }
    }
}

export { LeadTimeInWipCalculator };
