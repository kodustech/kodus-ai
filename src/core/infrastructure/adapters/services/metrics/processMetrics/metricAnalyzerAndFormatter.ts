import { isStrictlyNumber } from '@/shared/utils/transforms/numbers';
import * as moment from 'moment-timezone';
import { metricDictionary } from '../metricsDictionary';

export type MetricTrend = {
    metricType: string;
    date: string;
    original: any;
    differences: {
        date: string;
        difference: Difference;
        original: any;
    }[];
    description?: string;
    utcDate?: Date;
};

type Percentiles = {
    p50: number;
    p75: number;
    p85: number;
    p95: number;
};

type Difference = {
    predictions: any;
    date?: string;
    total?: any;
    value?: string | number;
    issues?: IssueDifference[];
    columns?: ColumnDifference[];
    original?: any;
};

type IssueDifference = {
    key: string;
    average: number;
};

type OutputData = {
    type: string;
    category: string;
    description: string;
    data: Array<{
        period: {
            start: string;
            end: string;
        };
        value: number;
        comparison?: {
            previousValue: number;
            change: string;
            direction: 'increase' | 'decrease';
        };
    }>;
};

type DataPointComparison = {
    comparedTo: { start: string; end: string };
    changeValue: string;
    direction: 'increase' | 'decrease' | 'no change';
};

type DataPoint = {
    period: { start: string; end: string };
    value: number;
    comparison?: DataPointComparison[];
};

type ProcessedMetricData = {
    type: string;
    category: string;
    description: string;
    data: DataPoint[];
};

type ColumnDifference = {
    column: string;
    averageDifference: number;
    percentileDifferences: Percentiles;
};

type ColumnData = {
    leadTime: number;
    comparison?: {
        date: any;
        change: string;
        direction: string;
    };
};

type PeriodData = {
    period: {
        start: string;
        end: string;
    };
    columns: Record<string, ColumnData>;
};

type MetricTemplate = {
    type: string;
    category: string;
    description: string;
    data: PeriodData[];
};

type PredictionTemplate = {
    issueKey: string;
    startDate: string;
    p75: string;
    isLate: boolean;
    aging: number;
};

type PredictedDeliveryDatesTemplate = {
    type: string;
    category: string;
    description: string;
    currentDate: string;
    predictions: PredictionTemplate[];
};

export class MetricTrendAnalyzerAndFormatter {
    constructor() {}

    analyzeMetricTrendsOverTime(
        metricType: string,
        metrics: any[],
    ): MetricTrend[] {
        const filteredMetrics = this.filterAndSortMetrics(metricType, metrics);

        const analyzedResults: MetricTrend[] = [];

        filteredMetrics.forEach((currentMetric, currentIndex) => {
            const metricDate = moment(currentMetric._referenceDate).format(
                'YYYY-MM-DD',
            );

            const differences = [];

            // For each current metric, compare it with all previous metrics.
            for (
                let previousIndex = 0;
                previousIndex < currentIndex;
                previousIndex++
            ) {
                const previousMetric = filteredMetrics[previousIndex];
                const comparisonResult = this.calculateMetricDifference(
                    metricType,
                    currentMetric,
                    previousMetric,
                );

                differences.push({
                    date: comparisonResult.date,
                    difference: {
                        ...comparisonResult,
                    },
                    original: previousMetric._value,
                });
            }

            analyzedResults.push({
                metricType: currentMetric._type,
                date: metricDate,
                original: currentMetric._value,
                differences: differences,
                description: metricDictionary(currentMetric._type),
                utcDate: currentMetric._referenceDate,
            });
        });

        return analyzedResults;
    }

    getLastMetricByType(
        metricType: string,
        metrics: MetricTrend[],
    ): MetricTrend {
        const metric = metrics[metricType];

        if (!metric) {
            return null;
        }

        return metric[metric?.length - 1];
    }

    getBugRationMetricFormatted(inputData: any): ProcessedMetricData {
        const processedData: any = {
            type: 'Bug Ratio',
            category: 'Metric',
            description:
                'Bug Ratio indicates the percentage of Work Items that are categorized as BUGs in relation to the total Work Items on the board, reflecting the quality and stability of the development output.',
            data: [],
        };

        inputData.forEach((metricObject: any) => {
            const date = moment(metricObject.date);
            const startOfWeek = date
                .clone()
                .subtract(7, 'days')
                .format('YYYY-MM-DD');
            const endOfWeek = date.clone().format('YYYY-MM-DD');

            const dataPoint: DataPoint = {
                period: { start: startOfWeek, end: endOfWeek },
                value: metricObject.original.value * 100,
                comparison: metricObject?.differences?.map((diff) => {
                    const originalValueForComparison =
                        metricObject.original.value - parseFloat(diff.value);
                    const changePercentage =
                        (parseFloat(diff.value) / originalValueForComparison) *
                        100;
                    const direction =
                        changePercentage > 0
                            ? 'increase'
                            : changePercentage < 0
                              ? 'decrease'
                              : 'no change';

                    return {
                        comparedTo: {
                            start: moment(diff.date)
                                .clone()
                                .subtract(7, 'days')
                                .format('YYYY-MM-DD'),
                            end: moment(diff.date).format('YYYY-MM-DD'),
                        },
                        changeValue: `${changePercentage.toFixed(2)}%`,
                        direction,
                    };
                }),
            };

            processedData.data.push(dataPoint);
        });

        return processedData;
    }

    getThroughputMetricFormatted(inputData: any): ProcessedMetricData {
        const processedData: any = {
            type: 'Throughput',
            category: 'Metric',
            description:
                "Throughput measures the total number of Work Items completed over a specific period, illustrating the team's productivity and efficiency in delivering outcomes. This metric highlights the flow of work through the development process, indicating the team's ability to address and fulfill tasks and objectives effectively.",
            data: [],
        };

        inputData.forEach((metricObject) => {
            const date = moment(metricObject.date);
            const startOfWeek = date
                .clone()
                .subtract(7, 'days')
                .format('YYYY-MM-DD');
            const endOfWeek = date.clone().format('YYYY-MM-DD');

            const dataPoint: DataPoint = {
                period: { start: startOfWeek, end: endOfWeek },
                value: metricObject.original.value,
                comparison: metricObject.differences.map((diff) => {
                    const originalValueForComparison =
                        metricObject.original.value - parseFloat(diff.value);
                    const changePercentage =
                        (parseFloat(diff.value) / originalValueForComparison) *
                        100;
                    const direction =
                        changePercentage > 0
                            ? 'increase'
                            : changePercentage < 0
                              ? 'decrease'
                              : 'no change';

                    return {
                        comparedTo: {
                            start: moment(diff.date)
                                .clone()
                                .subtract(7, 'days')
                                .format('YYYY-MM-DD'),
                            end: moment(diff.date).format('YYYY-MM-DD'),
                        },
                        changeValue: `${changePercentage.toFixed(2)}%`,
                        direction,
                    };
                }),
            };

            processedData.data.push(dataPoint);
        });

        return processedData;
    }

    getLeadTimeInWipMetricFormatted(inputData: any): any {
        const data: any[] = [];

        // Assuming inputData is an array with a single object containing all metric entries
        const metricsObject = inputData[0];

        Object.entries(metricsObject).forEach(
            ([dateStr, metricEntry]: any, index, array) => {
                const dateMoment = moment(dateStr);
                const startOfWeek = dateMoment
                    .subtract(7, 'days')
                    .format('YYYY-MM-DD');
                const endOfWeek = dateMoment.format('YYYY-MM-DD');

                const value = metricEntry.original.total.percentiles.p75; // Value based on p75

                const comparison: any[] = [];

                if (index > 0) {
                    // If not the first entry, calculate the comparison
                    for (let i = 0; i < index; i++) {
                        const previousEntry: any = array[i][1];
                        const previousValue =
                            previousEntry.original.total.percentiles.p75;

                        const change =
                            ((value - previousValue) / previousValue) * 100;
                        const direction =
                            change > 0
                                ? 'increase'
                                : change < 0
                                  ? 'decrease'
                                  : 'no change';

                        const compareToPeriod = {
                            start: moment(array[i][0])
                                .subtract(7, 'days')
                                .format('YYYY-MM-DD'),
                            end: moment(array[i][0]).format('YYYY-MM-DD'),
                        };

                        comparison.push({
                            compareToPeriod,
                            previousValue,
                            change: change.toFixed(2) + '%',
                            direction,
                        });
                    }
                }

                data.push({
                    period: { start: startOfWeek, end: endOfWeek },
                    value,
                    comparison: comparison.length > 0 ? comparison : undefined, // Include comparison if it exists
                });
            },
        );
        return {
            type: 'Lead Time In WIP',
            category: 'Metric',
            description:
                'Lead Time In WIP measures the average time that work items spend in progress before being completed, reflecting the efficiency of the workflow.',
            data,
        };
    }

    getLeadTimeByColumnMetricFormatted(inputData: any): MetricTemplate[] {
        const formattedData: MetricTemplate[] = [];

        const leadTimeByColumn: MetricTemplate = {
            type: 'Lead Time By Column',
            category: 'Metric',
            description:
                'Lead Time By Column measures the average time that work items spend in each column of the board, in hours, indicating potential bottlenecks or efficiencies in the development process.',
            data: [],
        };

        inputData.forEach((metric) => {
            if (metric.metricType === 'leadTimeByColumn') {
                const endDate = moment(metric.date);
                const startDate = endDate.clone().subtract(7, 'days');

                const periodData: PeriodData = {
                    period: {
                        start: startDate.format('YYYY-MM-DD'),
                        end: endDate.format('YYYY-MM-DD'),
                    },
                    columns: {},
                };

                Object.entries(metric.original).forEach(
                    ([columnName, leadTime]: [string, number]) => {
                        const columnData: ColumnData = { leadTime };

                        if (
                            metric.differences &&
                            metric.differences[columnName] !== undefined
                        ) {
                            const comparisonDate = metric.differences.date
                                ? moment(metric.differences.date).format(
                                      'YYYY-MM-DD',
                                  )
                                : null;
                            const differenceValue =
                                metric.differences[columnName];
                            const change =
                                (
                                    (parseFloat(differenceValue) / leadTime) *
                                    100
                                ).toFixed(2) + '%';
                            const direction =
                                parseFloat(differenceValue) > 0
                                    ? 'increase'
                                    : 'decrease';

                            columnData.comparison = {
                                date: comparisonDate, // Includes the comparison date correctly
                                change: change,
                                direction: direction,
                            };
                        }

                        periodData.columns[columnName] = columnData;
                    },
                );

                leadTimeByColumn.data.push(periodData);
            }
        });

        formattedData.push(leadTimeByColumn);

        return formattedData;
    }

    getPredictedDeliveryDatesFormatted(
        inputData: any,
    ): PredictedDeliveryDatesTemplate {
        const predictions: PredictionTemplate[] = inputData.flatMap(
            (metricGroup) =>
                metricGroup.original
                    .filter((prediction) => !prediction.errorMessage) // Filters valid predictions
                    .map((prediction) => ({
                        issueKey: prediction.issueKey,
                        startDate: moment(prediction.startDate, 'MM/DD').format(
                            'YYYY-MM-DD',
                        ),
                        p75: moment(prediction.p75, 'MM/DD').format(
                            'YYYY-MM-DD',
                        ),
                        isLate: prediction.isLate,
                        aging: prediction.aging,
                    })),
        );

        const formattedData: PredictedDeliveryDatesTemplate = {
            type: 'Predicted Delivery Dates',
            category: 'Forecast',
            description:
                'Predicted delivery dates based on the 75th percentile (p75) for tasks, providing a conservative estimate of when tasks are expected to be completed.',
            currentDate: moment().format('YYYY-MM-DD'), // Current date
            predictions,
        };

        return formattedData;
    }

    getGeneralLeadTimeFormatted(input: any): OutputData {
        const output: OutputData = {
            type: 'General Lead Time',
            category: 'Metric',
            description:
                'General Lead Time measures the time work items spend from start to completion, focusing on a key performance percentile to reflect workflow efficiency. This value represents a conservative estimate of delivery times across all tasks.',
            data: [],
        };

        input.forEach((item, index) => {
            const periodStart = moment(item.date)
                .subtract(7, 'days')
                .format('YYYY-MM-DD');
            const periodEnd = item.date;
            const value = item.original.total.percentiles.p75;

            const dataPoint = {
                period: { start: periodStart, end: periodEnd },
                value: value,
            };

            if (index > 0) {
                const previousValue =
                    input[index - 1].original.total.percentiles.p75;
                const change = ((value - previousValue) / previousValue) * 100;

                dataPoint['comparison'] = {
                    previousValue: previousValue,
                    change: change.toFixed(2) + '%',
                    direction: change > 0 ? 'increase' : 'decrease',
                };
            }

            output.data.push(dataPoint);
        });

        return output;
    }

    getLeadTimeByColumnFormatted(inputData: any): any {
        const output = {
            type: 'Lead Time by Column per Work Item',
            category: 'Metric',
            description:
                'Detailed Lead Time metrics for each work item by column for the specified period, providing insights into the specific durations tasks spend in different stages of the workflow.',
            periods: [] as any[],
        };

        inputData.forEach((metricEntry) => {
            const periodData = {
                startDate: moment(metricEntry.date).format('YYYY-MM-DD'), // Uses the metric's date as the end date
                endDate: moment(metricEntry.date)
                    .subtract(7, 'days')
                    .format('YYYY-MM-DD'),
                workItems: [] as any[],
            };

            metricEntry.original.issues.forEach((issueEntry: any) => {
                const workItemKey = Object.keys(issueEntry)[0];
                const columnsData = issueEntry[workItemKey];
                const workItemData = {
                    workItemKey,
                    columns: columnsData,
                };
                periodData.workItems.push(workItemData);
            });

            output.periods.push(periodData);
        });

        return output;
    }

    private filterAndSortMetrics(metricType: string, metrics: any[]): any[] {
        return metrics
            .filter((metric) => metric._type === metricType)
            .sort((a, b) =>
                moment(a._referenceDate).diff(moment(b._referenceDate)),
            );
    }

    private calculatePercentageChange(
        original: number,
        new_value: number,
    ): string {
        if (typeof original !== 'number' || typeof new_value !== 'number') {
            return 'Invalid input';
        }

        const percentageChange = ((new_value - original) / original) * 100;
        return percentageChange.toFixed(2) + '%';
    }

    private calculateMetricDifference(
        metricType: string,
        currentMetric: any,
        previousMetric?: any,
    ): Difference {
        const prevMetricDate = moment(previousMetric._referenceDate).format(
            'YYYY-MM-DD',
        );
        let differences: Partial<Difference> = {};

        // Your existing comparison and assignment logic goes here
        // For example:
        if (currentMetric._value.total && previousMetric._value.total) {
            differences.total = this.deepCompareAndCalculateDifferences(
                metricType,
                currentMetric._value.total,
                previousMetric._value.total,
            );
        }

        // Checks if it is dealing with a simple metric with a `value` property directly in `_value`
        if (
            'value' in currentMetric._value &&
            'value' in previousMetric._value
        ) {
            differences.value = this.calculatePrimitiveDifference(
                metricType,
                currentMetric._value.value,
                previousMetric._value.value,
            );
        }

        // Checks if both metrics have the `issues` property before attempting to calculate the differences
        if (currentMetric._value?.issues && previousMetric._value?.issues) {
            differences.issues = this.calculateIssueMetricDifferences(
                currentMetric._value,
                previousMetric._value,
            );
        }

        if (currentMetric._value.columns && previousMetric._value.columns) {
            differences.columns = currentMetric._value.columns.map(
                (currentColumn: any) => {
                    const previousColumn = previousMetric._value.columns.find(
                        (prevColumn: any) =>
                            prevColumn.column === currentColumn.column,
                    );

                    if (previousColumn) {
                        return {
                            column: currentColumn.column,
                            averageDifference:
                                currentColumn.average - previousColumn.average,
                            percentileDifferences:
                                this.calculatePercentileDifferences(
                                    currentColumn.percentile,
                                    previousColumn.percentile,
                                ),
                        };
                    } else {
                        // If the corresponding column is not found in the previous metric, return the current column data without calculating the difference
                        return {
                            column: currentColumn.column,
                            averageDifference: 0, // Or consider the entire average as the difference
                            percentileDifferences: currentColumn.percentile, // Or a specific logic to handle this
                        };
                    }
                },
            );
        }

        if (
            Array.isArray(currentMetric._value) &&
            Array.isArray(previousMetric._value)
        ) {
            differences.predictions = this.calculatePredictionsDifferences(
                currentMetric._value,
                previousMetric._value,
            );
        } else if (
            !('value' in currentMetric._value) &&
            !('issues' in currentMetric._value)
        ) {
            // Handles other types of metrics that are neither simple nor issue-based
            differences = {
                ...differences,
                ...this.deepCompareAndCalculateDifferences(
                    metricType,
                    currentMetric._value,
                    previousMetric._value,
                ),
            };
        }

        return {
            date: prevMetricDate,
            ...differences,
        } as Difference;
    }

    private calculatePercentileDifferences(
        currentPercentiles: any,
        previousPercentiles: any,
    ) {
        const percentileDifferences: any = {};
        Object.keys(currentPercentiles).forEach((key) => {
            percentileDifferences[key] =
                parseFloat(currentPercentiles[key]) -
                parseFloat(previousPercentiles[key]);
        });
        return percentileDifferences;
    }

    private calculatePredictionsDifferences(
        currentPredictions,
        previousPredictions,
    ) {
        const differences = currentPredictions.map((currentItem, index) => {
            const previousItem = previousPredictions[index] || {};

            // Prepares an object to accumulate the differences for the current item
            const itemDifferences: any = {};

            // Processes each property of the current item
            Object.keys(currentItem).forEach((key) => {
                if (
                    typeof currentItem[key] === 'number' &&
                    previousItem.hasOwnProperty(key)
                ) {
                    // Calculates the difference only for numeric values where the previous item exists
                    itemDifferences[key] = currentItem[key] - previousItem[key];
                } else {
                    // For non-numeric properties or those without a corresponding previous item, keeps the current value
                    itemDifferences[key] = currentItem[key];
                }
            });

            return itemDifferences;
        });

        return differences;
    }

    private calculateIssueMetricDifferences(currentMetric, previousMetric) {
        const currentIssues = currentMetric.issues;
        const previousIssues = previousMetric.issues;
        const differences = [];

        currentIssues.forEach((currentIssue) => {
            const issueKey = currentIssue.key || Object.keys(currentIssue)[0];
            const previousIssue = previousIssues.find(
                (pi) => pi.key === issueKey || Object.keys(pi)[0] === issueKey,
            );

            let issueDifferences = {};
            if (previousIssue) {
                // Simple structure {key: value}
                if ('average' in currentIssue) {
                    const metricDifference = this.calculateNumericDifference(
                        currentIssue.average,
                        previousIssue.average,
                    );
                    issueDifferences = {
                        key: issueKey,
                        average: metricDifference,
                    };
                } else {
                    // Complex structure {key: {subKey: value}}
                    const currentIssueMetrics = currentIssue[issueKey];
                    const previousIssueMetrics = previousIssue[issueKey];
                    issueDifferences[issueKey] =
                        this.calculateComplexMetricDifferences(
                            currentIssueMetrics,
                            previousIssueMetrics,
                        );
                }
            } else {
                issueDifferences = {
                    key: issueKey,
                    differences: 'No previous data',
                };
            }
            differences.push(issueDifferences);
        });

        return differences;
    }

    private calculateNumericDifference(currentValue, previousValue) {
        return Number((currentValue - previousValue || 0).toFixed(2));
    }

    private calculateComplexMetricDifferences(currentMetrics, previousMetrics) {
        const metricDifferences = {};
        Object.keys(currentMetrics).forEach((metric) => {
            metricDifferences[metric] = this.calculateNumericDifference(
                currentMetrics[metric],
                previousMetrics[metric],
            );
        });
        return metricDifferences;
    }

    private deepCompareAndCalculateDifferences(
        metricType,
        current,
        previous,
    ): any {
        if (typeof current !== 'object' || current === null) {
            return this.calculatePrimitiveDifference(
                metricType,
                current,
                previous,
            );
        }

        return Object.keys(current).reduce((acc, key) => {
            acc[key] = this.deepCompareAndCalculateDifferences(
                metricType,
                current[key],
                previous?.[key],
            );
            return acc;
        }, {});
    }

    private calculatePrimitiveDifference(
        metricType: string,
        current: number,
        previous: number,
    ): number {
        // First, check if both values are of type number to avoid calculations with incompatible types
        if (
            !isStrictlyNumber(current?.toString()) ||
            !isStrictlyNumber(previous?.toString())
        ) {
            return 0;
        }

        let difference = 0;

        if (current === 0) {
            difference = 0;
        }

        if (metricType && metricType === 'bugRatio') {
            difference = current - previous;
        } else {
            difference = previous - current;
        }

        return Number(difference.toFixed(2));
    }
}
