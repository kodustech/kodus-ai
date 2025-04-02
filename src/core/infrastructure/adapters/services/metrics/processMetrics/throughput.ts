import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import {
    getMetricPropertyByType,
    processAndAppendMetricData,
} from '@/shared/infrastructure/services/metrics';
import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import { apply, divide, subtract } from 'ramda';
import * as moment from 'moment-timezone';
import { Timezone } from '@/shared/domain/enums/timezones.enum';

interface ThroughputByItemType {
    workItemTypeId: string;
    workItemTypeName: string;
    value: number;
    percentageOfTotal: number;
}

interface DailyThroughput {
    value: number;
    throughputByItemType: ThroughputByItemType[];
}

class ThroughputCalculator {
    private columns: any[];
    private doneColumns: any[];
    private analysisPeriod?: {
        startTime: Date;
        endTime: Date;
    };

    setConfiguration(
        columns: any[],
        doneColumns: any[],
        analysisPeriod?: { startTime: Date; endTime: Date },
    ) {
        this.columns = columns;
        this.doneColumns = doneColumns;
        this.analysisPeriod = analysisPeriod;
    }

    calculateThroughput(): number {
        try {
            let count = 0;
            let transitionDate;
            const dateCalculatedInThroughput: Date[] = [];

            for (const column of this.columns) {
                for (const workItem of column.workItems) {
                    for (const entry of workItem.changelog) {
                        for (const item of entry.movements) {
                            if (
                                item.field === 'status' &&
                                this.doneColumns.some(
                                    (done) => done === item.toColumnId,
                                )
                            ) {
                                if (
                                    this.doneColumns.some(
                                        (done) => done === item.fromColumnId,
                                    )
                                ) {
                                    const previousStatus =
                                        workItem.changelog.find((prevEntry) =>
                                            prevEntry.movements.some(
                                                (movement) =>
                                                    movement.toColumnId ===
                                                    item.fromColumnId,
                                            ),
                                        );

                                    transitionDate = previousStatus
                                        ? new Date(previousStatus.created)
                                        : new Date(entry.created);
                                } else {
                                    transitionDate = new Date(entry.created);
                                }

                                if (
                                    transitionDate >=
                                        this.analysisPeriod.startTime &&
                                    transitionDate <=
                                        this.analysisPeriod.endTime
                                ) {
                                    count++;
                                    dateCalculatedInThroughput.push(
                                        transitionDate,
                                    );
                                }
                            }
                        }
                    }
                }
            }

            if (count === 0) {
                return 0;
            }

            const weeksCount = this.getWeeksCalculatedInThroughput(
                dateCalculatedInThroughput,
            );

            return Math.round(Number(count.toFixed(3)) / weeksCount);
        } catch (error) {
            console.log(error);
        }
    }

    calculateDailyThroughput(date: Date): DailyThroughput {
        if (!moment(date).isValid()) {
            date = new Date();
        }

        try {
            const startOfDay = moment(date).startOf('day').toDate();
            const endOfDay = moment(date).endOf('day').toDate();

            const throughputByType: Map<string, ThroughputByItemType> =
                new Map();
            let totalCount = 0;

            for (const column of this.columns) {
                for (const workItem of column.workItems) {
                    for (const entry of workItem.changelog) {
                        for (const item of entry.movements) {
                            if (
                                item.field === 'status' &&
                                this.doneColumns.some(
                                    (done) => done === item.toColumnId,
                                )
                            ) {
                                const transitionDate = new Date(entry.created);
                                if (
                                    transitionDate >= startOfDay &&
                                    transitionDate <= endOfDay
                                ) {
                                    totalCount++;

                                    const workItemType = workItem.workItemType;
                                    if (workItemType) {
                                        const typeCount = throughputByType.get(
                                            workItemType.id,
                                        ) || {
                                            workItemTypeId: workItemType.id,
                                            workItemTypeName: workItemType.name,
                                            value: 0,
                                            percentageOfTotal: 0,
                                        };
                                        typeCount.value++;
                                        throughputByType.set(
                                            workItemType.id,
                                            typeCount,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (totalCount > 0) {
                for (const typeCount of throughputByType.values()) {
                    typeCount.percentageOfTotal = Number(
                        ((typeCount.value / totalCount) * 100).toFixed(2),
                    );
                }
            }

            return {
                value: totalCount,
                throughputByItemType:
                    totalCount > 0 ? Array.from(throughputByType.values()) : [],
            };
        } catch (error) {
            console.error('Error calculating daily throughput:', error);
            throw error;
        }
    }

    private getWeeksCalculatedInThroughput(
        dateCalculatedInThroughput: Date[],
    ): number {
        try {
            // Extracts the minimum and maximum dates using Ramda functions
            const minDate = apply(
                Math.min,
                dateCalculatedInThroughput.map((date) => date.getTime()),
            );
            const maxDate = apply(
                Math.max,
                dateCalculatedInThroughput.map((date) => date.getTime()),
            );

            // Calculates the difference in weeks
            const differenceInWeeks = divide(
                subtract(maxDate, minDate),
                7 * 24 * 60 * 60 * 1000,
            );

            // Ensures that the minimum returned is 1 week, even if the difference is less than 1 week
            return Math.max(Math.floor(differenceInWeeks), 1);
        } catch (error) {
            console.error(error);
            return 0;
        }
    }

    calculateAverageCompanyThroughput(
        throughputMetrics: IOrganizationMetrics[],
    ): number {
        const throughputValues: number[] = [];

        for (const metric of throughputMetrics) {
            if (metric?.value?.value !== undefined) {
                throughputValues.push(metric.value.value);
            } else if (metric?.value !== undefined) {
                throughputValues.push(metric.value);
            } else {
                throughputValues.push(0);
            }
        }

        const sum = throughputValues.reduce((a, b) => a + b, 0);
        return Math.round(sum / throughputValues.length);
    }

    processAndAppendThroughput(throughputResult, throughputData, teamName) {
        return processAndAppendMetricData(
            throughputResult,
            throughputData,
            teamName,
            (metric) => metric?.original?.total?.value,
        );
    }

    formatThroughputForTeamAndPeriod(
        data: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        return data.map((metric, index) => {
            const completeItems =
                metric?.original?.completeResult ??
                metric?.original?.throughputByItemType ??
                [];

            // Group and sum by workItemTypeId
            const groupedItems = completeItems.reduce((acc, curr) => {
                const existing = acc.find(
                    (item) => item.workItemTypeId === curr.workItemTypeId,
                );
                if (existing) {
                    existing.value += curr.value;
                } else {
                    acc.push({ ...curr });
                }
                return acc;
            }, []);

            // Recalculate percentages
            const total = groupedItems.reduce(
                (sum, item) => sum + item.value,
                0,
            );
            groupedItems.forEach((item) => {
                item.percentageOfTotal = ((item.value / total) * 100).toFixed(
                    2,
                );
            });

            return {
                date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YY'),
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                value:
                    metric?.original?.total?.value ??
                    metric?.original?.value ??
                    0,
                completeResult: groupedItems,
                order: index + 1,
            };
        });
    }

    processThroughputForCockpit(data: any) {
        const throughput = data.throughput;

        if (throughput.length > 1) {
            const recent =
                typeof throughput[1].original.value === 'number'
                    ? throughput[1].original.value
                    : throughput[1].original.total.value || 0;
            const previous =
                typeof throughput[0].original.value === 'number'
                    ? throughput[0].original.value
                    : throughput[0].original.total.value || 0;
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
                name: METRICS_TYPE.THROUGHPUT,
                title: 'Throughput',
                result: recent.toString(),
                resultObs: recent === 1 ? 'delivered item' : 'delivered items',
                resultType:
                    !realDifference || realDifference === 0
                        ? 'Same'
                        : previous > recent
                          ? 'Negative'
                          : 'Positive',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    'throughput',
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType('throughput', 'whatIsIt'),
                layoutIndex: 2,
            };
        }
    }
}

export { ThroughputCalculator };
