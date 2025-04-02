import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import { LeadTimeFormat } from '@/shared/utils/formatters/leadTime';
import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

/**
 * @class LeadTimeCalculator
 * Responsible for calculating lead times based on state transitions.
 */
class LeadTimeCalculator {
    private leadTimes: { [key: string]: number } = {};
    private entryDates: { [key: string]: Date } = {};
    private transitions: any[] = [];

    private changelog: any[];
    private columnsConfig: ColumnsConfigResult;
    private considerAll: boolean = true;
    private workItemCreatedAt: Date;
    private todayDate?: Date;

    setConfiguration(
        changelog: any[],
        columnsConfig: ColumnsConfigResult,
        considerAll: boolean = true,
        workItemCreatedAt: Date,
        todayDate?: Date,
    ) {
        this.changelog = changelog;
        this.columnsConfig = columnsConfig;
        this.considerAll = considerAll;
        this.workItemCreatedAt = workItemCreatedAt;
        this.todayDate = todayDate;

        this.transitions = this.filterAndSortTransitions();
    }

    /**
     * @method calculateLeadTime
     * Calculates and returns the lead times.
     */
    public calculateLeadTime(): {
        leadTimes: { [key: string]: number };
        totalLeadTime?: number;
    } {
        if (this.transitions.length === 0) {
            this.handleNoTransitions();
        } else {
            this.handleTransitions();
        }

        // Updates the lead times for all columns if the `considerAll` flag is enabled.
        this.updateLeadTimesForAllColumns();

        // Returns the lead times and the total lead time, considering the `considerAll` flag.
        return this.handleConsiderAllFlag();
    }
    handleSkippedColumns(result) {
        // Finds the maximum index of columns configured in WIP
        const maxWIPOrder = this.columnsConfig.allColumns.reduce(
            (max, column) => {
                if (
                    column.order !== null &&
                    column.column !== 'todo' &&
                    column.column !== 'done'
                ) {
                    return Math.max(max, column.order);
                }
                return max;
            },
            0,
        );

        // Add index 0 for 'todo' column and max for 'done' column
        const mappedColumns = this.columnsConfig.allColumns.map((column) => {
            let order: number;

            if (column.order !== null) {
                order = column.order;
            } else if (column.column === 'todo') {
                order = 0; // Assign 0 for 'todo' columns without 'order'
            } else if (column.column === 'done') {
                order = maxWIPOrder + 1; // Assign 'last order + 1' for 'done' columns
            } else {
                order = -1; // Default value if none of the above conditions are true
            }

            return {
                name: column.name,
                column: column.column,
                order: order,
            };
        });

        // Map column order to lead time values
        const mappedValues = Object.entries(result.leadTimes).map(
            (leadTime) => {
                return {
                    name: leadTime[0] as string,
                    value: leadTime[1] as number,
                    order: mappedColumns.find(
                        (column) => column.name === leadTime[0],
                    ).order,
                };
            },
        );

        // Get the last column that this issue passed through
        const maxColumnHit = mappedValues.reduce((maxItem, currentItem) => {
            return maxItem.order > currentItem.order ? maxItem : currentItem;
        }, mappedValues[0]).order;

        const leadTimes = {};

        for (const column of mappedColumns) {
            if (column.order > maxColumnHit) continue;

            const value: number = mappedValues.find(
                (leadTime) => leadTime.order === column.order,
            )?.value;

            if (value > 0) {
                leadTimes[column.name] = value;
            } else {
                leadTimes[column.name] = 0;
            }
        }
        return { leadTimes, totalLeadTime: result.totalLeadTime };
    }

    /**
     * @method filterAndSortTransitions
     * Filters and sorts the status transitions.
     */
    private filterAndSortTransitions(): any[] {
        const transitions = this.changelog.filter((entry) =>
            entry.movements.some((item) => item.field === 'status'),
        );
        transitions.sort(
            (a, b) =>
                new Date(a.created).getTime() - new Date(b.created).getTime(),
        );
        return transitions;
    }

    /**
     * @method handleNoTransitions
     * Logic to handle scenarios where there are no transitions.
     */
    private handleNoTransitions() {
        const initialColumn = this.columnsConfig.allColumns[0];

        const currentDate = this.todayDate || new Date();

        if (this.considerAll && initialColumn) {
            this.leadTimes[initialColumn.name] =
                (currentDate.getTime() - this.workItemCreatedAt.getTime()) /
                (1000 * 3600);
        }
    }

    /**
     * @method handleTransitions
     * Logic to handle status transitions
     */
    private handleTransitions() {
        // Get the first transaction of the issue
        const firstTransition = this.transitions[0].movements.find(
            (item) => item.field === 'status',
        );

        // If the first transition is the creation of the issue (without a previous state),
        // record the time from creation to the first transition.
        if (
            firstTransition &&
            (!firstTransition.fromColumnId ||
                !firstTransition.fromColumnName) &&
            firstTransition.toColumnId
        ) {
            // Calculate the time (in hours) from the creation of the issue to its first transition.
            // This is done by subtracting the issue's creation timestamp from the first transition's timestamp
            // and then converting the result from milliseconds to hours.
            const timeSinceCreation =
                (new Date(this.transitions[0].created).getTime() -
                    this.workItemCreatedAt.getTime()) /
                (1000 * 3600);

            // Record the calculated time in `leadTimes` for the column (or status) to which the issue was moved.
            // `this.columnIdToName[firstTransition.to]` gets the column name using the column ID.
            const currentIndexColumnConfig: number =
                this.columnsConfig.allColumns.findIndex(
                    (column: ColumnsConfigKey) =>
                        column.id === firstTransition.toColumnId,
                );

            this.leadTimes[
                this.columnsConfig.allColumns[currentIndexColumnConfig]?.name
            ] = timeSinceCreation;

            // Since this is the first transition of the issue, the entry date (`entryDates`) for this column
            // is the same as the issue's creation date. Therefore, the issue's creation date is recorded
            // as the entry date for this column (or status).
            this.entryDates[firstTransition.toColumnId] =
                this.workItemCreatedAt;
        }
        // If the issue already had a previous status in the first transition,
        // record the creation date as the entry date for that column.
        else if (firstTransition && firstTransition.fromColumnId) {
            this.entryDates[firstTransition.fromColumnId] =
                this.workItemCreatedAt;
        }

        // Process all subsequent transitions.
        for (const transition of this.transitions) {
            const currentDate = new Date(transition.created);
            for (const item of transition.movements) {
                if (item.field === 'status') {
                    const currentColumn = item.toColumnId;
                    const previousColumn = item.fromColumnId;

                    if (currentColumn && previousColumn) {
                        const currentIndexColumnConfig: number =
                            this.columnsConfig.allColumns.findIndex(
                                (column: ColumnsConfigKey) =>
                                    column.id === currentColumn,
                            );

                        const previousIndexColumnConfig: number =
                            this.columnsConfig.allColumns.findIndex(
                                (column: ColumnsConfigKey) =>
                                    column.id === previousColumn,
                            );

                        if (currentIndexColumnConfig < 0) {
                            continue;
                        }

                        if (
                            currentIndexColumnConfig < previousIndexColumnConfig
                        ) {
                            // Calculate the time the issue spent in the current column before regressing to the previous column.
                            const timeSpentInCurrent = this.entryDates[
                                previousColumn
                            ]
                                ? (currentDate.getTime() -
                                      new Date(
                                          this.entryDates[previousColumn],
                                      ).getTime()) /
                                  (1000 * 3600)
                                : 0;

                            /**
                             * Since the issue regressed, the time it spent in the current column is added to the lead time of the previous column.
                             * This is done because we assume that the work done in the current column now becomes part of the work
                             * of the previous column due to the regression.
                             */

                            this.leadTimes[
                                this.columnsConfig.allColumns[
                                    currentIndexColumnConfig
                                ]?.name
                            ] =
                                (this.leadTimes[
                                    this.columnsConfig.allColumns[
                                        currentIndexColumnConfig
                                    ].name
                                ] || 0) + timeSpentInCurrent;

                            /**
                             * Since the issue regressed from the current column, the entry date for this column is removed.
                             * This ensures that the issue is not counted in this column when calculating lead times in the future.
                             */
                            delete this.entryDates[previousColumn];

                            /**
                             * The lead time record for the current column is also removed, as the issue regressed and
                             * the time spent here is now accounted for in the previous column.
                             */
                            delete this.leadTimes[
                                this.columnsConfig.allColumns[
                                    previousIndexColumnConfig
                                ].name
                            ];
                        } else {
                            const previousIndexColumnConfig: number =
                                this.columnsConfig.allColumns.findIndex(
                                    (column: ColumnsConfigKey) =>
                                        column.id === previousColumn,
                                );
                            /**
                             * If the issue advanced to the next column.
                             */
                            // Calculate the time the issue spent in the previous column before advancing to the next column.
                            const timeSpent = this.entryDates[previousColumn]
                                ? (currentDate.getTime() -
                                      new Date(
                                          this.entryDates[previousColumn],
                                      ).getTime()) /
                                  (1000 * 3600)
                                : 0;

                            /**
                             * Add the time the issue spent in the previous column to the lead time of that column.
                             */
                            if (
                                this.columnsConfig.allColumns[
                                    previousIndexColumnConfig
                                ]?.name
                            ) {
                                this.leadTimes[
                                    this.columnsConfig.allColumns[
                                        previousIndexColumnConfig
                                    ].name
                                ] =
                                    (this.leadTimes[
                                        this.columnsConfig.allColumns[
                                            previousIndexColumnConfig
                                        ].name
                                    ] || 0) + timeSpent;

                                /**
                                 * Remove the entry date for the previous column, as the issue has already moved to the next column.
                                 * This ensures that the issue is not counted in this column when calculating lead times in the future.
                                 */
                                delete this.entryDates[previousColumn];
                            }
                        }

                        // Record the current transition date as the entry date for the current column.
                        this.entryDates[currentColumn] = transition.created;
                    }
                }
            }
        }
    }

    private calculateTotalLeadTime(): number {
        const validColumns = this.columnsConfig.allColumns
            .filter((column) => column.column !== 'done')
            .map((column) => column.name);

        let totalLeadTime = 0;

        // Iterates over the properties of the leadTimes object
        for (const [columnName, time] of Object.entries(this.leadTimes)) {
            if (validColumns.includes(columnName)) {
                totalLeadTime += time;
            }
        }

        return Number(totalLeadTime.toFixed(3));
    }

    /**
     * Updates the lead times for all columns.
     *
     * @private
     */
    private updateLeadTimesForAllColumns() {
        // If `considerAll` is true, we need to consider the time from the last
        // transition to the current moment to calculate the lead times.
        if (this.considerAll) {
            // Iterating over each column in `entryDates`.
            for (const column in this.entryDates) {
                // Updating the lead time for the current column by adding the time from the last transition to now.
                // Converting the time from milliseconds to hours (divided by 1000*3600).
                const currentIndexColumnConfig: number =
                    this.columnsConfig.allColumns.findIndex(
                        (item: ColumnsConfigKey) => item.id === column,
                    );

                if (currentIndexColumnConfig >= 0) {
                    // Filters all issue movements where it exited the column we are calculating the lead time for.
                    const currentDate = this.todayDate || new Date();

                    const filterTransition = this.transitions?.filter(
                        (transition) => {
                            return (
                                transition?.movements[0]?.fromColumnId ===
                                column
                            );
                        },
                    );

                    const mostRecentDate =
                        this.findMostRecentDate(filterTransition);

                    // Compares if the date of the last movement is greater than the date from `entryDates`.
                    // This means the issue did not stay in that column, and we cannot calculate the lead time based on today's date.
                    if (
                        mostRecentDate &&
                        new Date(mostRecentDate).getTime() >
                            new Date(this.entryDates[column]).getTime()
                    ) {
                        let leadTime = 0;
                        for (const transition of filterTransition) {
                            const previousTransition =
                                this.getPreviousTransition(transition);

                            if (previousTransition) {
                                // Calculates how much time the issue stayed in the column.
                                leadTime +=
                                    (new Date(transition.created).getTime() -
                                        new Date(
                                            previousTransition.created,
                                        ).getTime()) /
                                    (1000 * 3600);
                            }
                        }
                        this.leadTimes[
                            this.columnsConfig.allColumns[
                                currentIndexColumnConfig
                            ].name
                        ] = leadTime;
                    } else {
                        this.leadTimes[
                            this.columnsConfig.allColumns[
                                currentIndexColumnConfig
                            ].name
                        ] =
                            (this.leadTimes[
                                this.columnsConfig.allColumns[
                                    currentIndexColumnConfig
                                ].name
                            ] || 0) +
                            (currentDate.getTime() -
                                new Date(this.entryDates[column]).getTime()) /
                                (1000 * 3600);
                    }
                }
            }
        }
    }

    /**
     * Finds the most recent transition.
     */
    private findMostRecentDate(transitions) {
        const transition = transitions?.reduce((maxObj, obj) => {
            const currentDate = new Date(obj.created);
            const maxDate = maxObj ? new Date(maxObj.created) : null;

            if (!maxDate || currentDate > maxDate) {
                return obj;
            } else {
                return maxObj;
            }
        }, null);

        return transition?.created ?? '';
    }

    /**
     * Gets the previous transition of the one passed as a parameter.
     */
    private getPreviousTransition(transitionParam) {
        const currentIndexColumnConfig: number = this.transitions.findIndex(
            (transition) => transition.id === transitionParam.id,
        );
        return this.transitions[currentIndexColumnConfig - 1];
    }

    /**
     * Handles the considerAll flag and returns the lead times and total lead time.
     *
     * @return {{ leadTimes: { [key: string]: number }, totalLeadTime?: number }} The lead times and total lead time.
     */
    private handleConsiderAllFlag(): {
        leadTimes: { [key: string]: number };
        totalLeadTime?: number;
    } {
        const totalLeadTime: number = this.calculateTotalLeadTime();

        // If `considerAll` is false, and if the last transition was not to the "done" column,
        // the lead times should be returned as an empty object.
        if (
            !this.considerAll &&
            this.transitions.length > 0 &&
            this.transitions[this.transitions.length - 1].movements.some(
                (item) =>
                    item.field === 'status' &&
                    this.columnsConfig.doneColumns.some(
                        (done) => done === item.toColumnId,
                    ),
            )
        ) {
            return { leadTimes: {} };
        }

        // If we didn't return earlier, we return the calculated lead times and the total lead time.
        return { leadTimes: this.formatResults(), totalLeadTime };
    }

    private formatResults() {
        return Object.entries(this.leadTimes).reduce(
            (formattedObject, [key, value]) => {
                formattedObject[key] = Number(value.toFixed(3)); // Formats the value and converts it back to a number
                return formattedObject;
            },
            {},
        );
    }

    calculateAverageCompanyLeadTime(
        leadTimeMetrics: IOrganizationMetrics[],
    ): number {
        const leadTimeValues: number[] = [];

        for (const metric of leadTimeMetrics) {
            leadTimeValues.push(metric.value.total.average);
        }

        const sum = leadTimeValues.reduce((a, b) => a + b, 0);
        return Math.round(sum / leadTimeValues.length);
    }

    processAndAppendLeadTime(leadTimeResult, leadTimeData, teamName) {
        return processAndAppendMetricData(
            leadTimeResult,
            leadTimeData,
            teamName,
            (metric) => metric.original.total.percentiles?.p75 / 24,
        );
    }

    formatLeadTimeForTeamAndPeriod(
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
        const leadTime = data.leadTime;

        if (leadTime.length > 1) {
            const recent = leadTime[1].original.total.percentiles.p75;
            const previous = leadTime[0].original.total.percentiles.p75;

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
                name: METRICS_TYPE.LEAD_TIME,
                title: 'LeadTime',
                result: LeadTimeFormat(recent),
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : recent > previous
                          ? 'Negative'
                          : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    leadTime[0].metricType,
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType(
                    leadTime[0].metricType,
                    'whatIsIt',
                ),
                layoutIndex: 4,
            };
        }
    }
}

export { LeadTimeCalculator };
