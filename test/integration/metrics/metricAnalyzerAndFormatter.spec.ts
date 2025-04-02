import { MetricTrendAnalyzerAndFormatter } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metricAnalyzerAndFormatter';
import {
    bugRatioResult,
    getMockMetrics,
    leadTimeByColumnResult,
    leadTimeInWipResult,
    leadTimeResult,
    predictedDeliveryDatesResult,
    throughputResult,
} from 'test/mocks/data/metricsToAnalyzerAndFormatter';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';

describe('MetricTrendAnalyzerAndFormatter', () => {
    let metricTrendAnalyzerAndFormatter;

    beforeEach(() => {
        metricTrendAnalyzerAndFormatter = new MetricTrendAnalyzerAndFormatter();
    });

    describe('analyzeMetricTrendsOverTime', () => {
        it('should correctly analyze metric trends over time', () => {
            const metricsMock = getMockMetrics();

            const predictedDeliveryDates =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.PREDICTED_DELIVERY_DATES,
                    metricsMock,
                );

            const bugRatio =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.BUG_RATIO,
                    metricsMock,
                );

            const throughput =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.THROUGHPUT,
                    metricsMock,
                );

            const leadTime =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME,
                    metricsMock,
                );

            const leadTimeInWip =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME_IN_WIP,
                    metricsMock,
                );

            const leadTimeByColumn =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                    metricsMock,
                );

            expect(predictedDeliveryDates).toBeInstanceOf(Array);
            expect(bugRatio).toBeInstanceOf(Array);
            expect(throughput).toBeInstanceOf(Array);
            expect(leadTime).toBeInstanceOf(Array);
            expect(leadTimeInWip).toBeInstanceOf(Array);
            expect(leadTimeByColumn).toBeInstanceOf(Array);
        });

        it('should analyze predicted delivery dates metric trends correctly', () => {
            const metricsMock = getMockMetrics();
            const expectedOutput = predictedDeliveryDatesResult();

            const result =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.PREDICTED_DELIVERY_DATES,
                    metricsMock,
                );

            expect(result.length).toEqual(expectedOutput.length);

            if (result.length > 0) {
                const firstResultItem = result[0];
                const firstExpectedItem = expectedOutput[0];

                expect(firstResultItem.metricType).toEqual(
                    firstExpectedItem.metricType,
                );
                expect(firstResultItem.date).toEqual(firstExpectedItem.date);
                expect(firstResultItem.original.length).toEqual(
                    firstExpectedItem.original.length,
                );

                firstResultItem.original.forEach((originalItem, index) => {
                    const expectedOriginalItem =
                        firstExpectedItem.original[index];

                    expect(originalItem.issueKey).toEqual(
                        expectedOriginalItem.issueKey,
                    );
                    expect(originalItem.startDate).toEqual(
                        expectedOriginalItem.startDate,
                    );
                    expect(originalItem.p50).toEqual(expectedOriginalItem.p50);
                    expect(originalItem.p75).toEqual(expectedOriginalItem.p75);
                    expect(originalItem.p95).toEqual(expectedOriginalItem.p95);
                    expect(originalItem.aging).toEqual(
                        expectedOriginalItem.aging,
                    );
                    expect(originalItem.isLate).toEqual(
                        expectedOriginalItem.isLate,
                    );
                });

                expect(firstResultItem.description).toEqual(
                    firstExpectedItem.description,
                );
            }
        });

        it('should correctly analyze and output bug ratio metrics with calculated differences', () => {
            const metricsMock = getMockMetrics();
            const bugRatioExpectedResult = bugRatioResult();

            const bugRatioResults =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.BUG_RATIO,
                    metricsMock,
                );

            expect(bugRatioResults.length).toBe(bugRatioExpectedResult.length);

            delete bugRatioResults[0].utcDate;
            delete bugRatioExpectedResult[0].utcDate;

            expect(bugRatioResults[0]).toEqual(bugRatioExpectedResult[0]);

            expect(bugRatioResults[1].metricType).toEqual(
                bugRatioExpectedResult[1].metricType,
            );
            expect(bugRatioResults[1].original.value).toEqual(
                bugRatioExpectedResult[1].original.value,
            );
            expect(bugRatioResults[1].differences.length).toBe(
                bugRatioExpectedResult[1].differences.length,
            );

            const firstDifference = bugRatioResults[1].differences[0];
            const expectedFirstDifference =
                bugRatioExpectedResult[1].differences[0];
            expect(firstDifference.date).toEqual(expectedFirstDifference.date);
            expect(firstDifference.difference.value).toBeCloseTo(
                expectedFirstDifference.difference.value,
            );
        });

        it('should correctly analyze and output throughput metrics with calculated differences', () => {
            const metricsMock = getMockMetrics();
            const throughputExpectedResult = throughputResult();

            const throughputResults =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.THROUGHPUT,
                    metricsMock,
                );

            delete throughputResults[0].utcDate;

            expect(throughputResults.length).toBe(
                throughputExpectedResult.length,
            );

            expect(throughputResults[0]).toEqual(throughputExpectedResult[0]);

            expect(throughputResults[1].metricType).toEqual(
                throughputExpectedResult[1].metricType,
            );
            expect(throughputResults[1].original.value).toEqual(
                throughputExpectedResult[1].original.value,
            );
            expect(throughputResults[1].differences.length).toBe(
                throughputExpectedResult[1].differences.length,
            );

            const firstDifference = throughputResults[1].differences[0];
            const expectedFirstDifference =
                throughputExpectedResult[1].differences[0];
            expect(firstDifference.date).toEqual(expectedFirstDifference.date);
            expect(firstDifference.difference.value).toEqual(
                expectedFirstDifference.difference.value,
            );
        });

        it('should correctly analyze and output lead time in WIP metrics with calculated differences', () => {
            const metricsMock = getMockMetrics();
            const leadTimeInWipExpectedResult = leadTimeInWipResult();

            const leadTimeInWipResults =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME_IN_WIP,
                    metricsMock,
                );

            expect(leadTimeInWipResults.length).toBe(
                leadTimeInWipExpectedResult.length,
            );

            leadTimeInWipResults.forEach((result, index) => {
                const expected = leadTimeInWipExpectedResult[index];

                expect(result.metricType).toEqual(expected.metricType);

                if (result.differences && expected.differences) {
                    expect(result.differences.length).toBe(
                        expected.differences.length,
                    );
                    result.differences.forEach((difference, diffIndex) => {
                        const expectedDifference =
                            expected.differences[diffIndex];
                        expect(difference).toEqual(expectedDifference);
                    });
                }
            });
        });

        it('correctly analyzes lead time by column metrics, including differences', () => {
            const metricsMock = getMockMetrics();
            const expectedResults = leadTimeByColumnResult();

            const leadTimeByColumnResults =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                    metricsMock,
                );

            expect(leadTimeByColumnResults.length).toEqual(
                expectedResults.length,
            );

            leadTimeByColumnResults.forEach((result, index) => {
                const expectedResult = expectedResults[index];

                expect(result.metricType).toEqual(expectedResult.metricType);
                expect(result.date).toEqual(expectedResult.date);
                expect(result.original).toEqual(expectedResult.original);
                expect(result.description).toEqual(expectedResult.description);

                if (expectedResult.differences.length > 0) {
                    const resultDifferences = result.differences[0];
                    const expectedDifferences = expectedResult.differences[0];

                    expect(resultDifferences.date).toEqual(
                        expectedDifferences.date,
                    );

                    Object.entries(expectedDifferences.difference).forEach(
                        ([column, value]) => {
                            expect(
                                resultDifferences.difference[column],
                            ).toEqual(value);
                        },
                    );

                    expect(resultDifferences.original).toEqual(
                        expectedDifferences.original,
                    );
                }
            });
        });

        it('correctly analyzes lead time metrics, including issue details and differences', () => {
            const metricsMock = getMockMetrics();
            const expectedResults = leadTimeResult();

            const leadTimeResults =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME,
                    metricsMock,
                );

            expect(leadTimeResults.length).toEqual(expectedResults.length);

            leadTimeResults.forEach((result, index) => {
                const expectedResult = expectedResults[index];

                expect(result.metricType).toEqual(expectedResult.metricType);
                expect(result.date).toEqual(expectedResult.date);
                expect(result.description).toEqual(expectedResult.description);

                expect(result.original.total.average).toEqual(
                    expectedResult.original.total.average,
                );
                expect(result.original.total.percentiles).toEqual(
                    expectedResult.original.total.percentiles,
                );

                result.original.issues.forEach((issue, issueIndex) => {
                    const expectedIssue =
                        expectedResult.original.issues[issueIndex];
                    const issueKey = Object.keys(issue)[0];
                    const expectedIssueKey = Object.keys(expectedIssue)[0];

                    expect(issueKey).toEqual(expectedIssueKey);
                    expect(issue[issueKey]).toEqual(
                        expectedIssue[expectedIssueKey],
                    );
                });

                result.original.columns.forEach((column, columnIndex) => {
                    const expectedColumn =
                        expectedResult.original.columns[columnIndex];
                    expect(column).toEqual(expectedColumn);
                });

                if (expectedResult.differences.length > 0) {
                    const difference = result.differences[0];
                    const expectedDifference = expectedResult.differences[0];

                    expect(difference.date).toEqual(expectedDifference.date);
                    expect(difference.difference).toEqual(
                        expectedDifference.difference,
                    );

                    expect(difference.original).toEqual(
                        expectedDifference.original,
                    );
                }
            });
        });
    });

    describe('Validation of Metrics Data', () => {
        it('should handle empty metrics data gracefully', () => {
            const emptyMetrics = [];
            const result =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.THROUGHPUT,
                    emptyMetrics,
                );

            expect(result).toBeInstanceOf(Array);
            expect(result.length).toBe(0);
        });

        it('should return error or default value for invalid metrics type', () => {
            const metricsMock = getMockMetrics();
            const result =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    'INVALID_METRICS_TYPE',
                    metricsMock,
                );

            expect(result).toEqual([]);
        });
    });

    describe('should check whether the formatting returns are in accordance.', () => {
        it('should format bug ratio metric data correctly', () => {
            const metricsMock = getMockMetrics();

            const bugRatio =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.BUG_RATIO,
                    metricsMock,
                );
            const formattedData =
                metricTrendAnalyzerAndFormatter.getBugRationMetricFormatted(
                    bugRatio,
                );

            expect(formattedData).toHaveProperty('type', 'Bug Ratio');
            expect(formattedData).toHaveProperty('description');
            expect(formattedData).toHaveProperty('category');
            expect(formattedData).toHaveProperty('data');
            expect(Array.isArray(formattedData.data)).toBeTruthy();
            expect(formattedData.data.length).toBeGreaterThan(0);

            expect(formattedData.description).toBe(
                'Bug Ratio indicates the percentage of Work Items that are categorized as BUGs in relation to the total Work Items on the board, reflecting the quality and stability of the development output.',
            );
            expect(formattedData.category).toBe('Metric');

            if (formattedData.data.length > 0) {
                const firstDataPoint = formattedData.data[0];
                expect(firstDataPoint).toHaveProperty('period');
                expect(firstDataPoint).toHaveProperty('value');
                expect(firstDataPoint).toHaveProperty('comparison');
            }
        });

        it('should format throughput metric data correctly', () => {
            const metricsMock = getMockMetrics();

            const throughput =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.THROUGHPUT,
                    metricsMock,
                );

            const formattedData =
                metricTrendAnalyzerAndFormatter.getThroughputMetricFormatted(
                    throughput,
                );

            expect(formattedData).toHaveProperty('type', 'Throughput');
            expect(formattedData).toHaveProperty('description');
            expect(formattedData).toHaveProperty('category');
            expect(formattedData).toHaveProperty('data');
            expect(Array.isArray(formattedData.data)).toBeTruthy();
            expect(formattedData.data.length).toBeGreaterThan(0);

            expect(formattedData.description).toBe(
                "Throughput measures the total number of Work Items completed over a specific period, illustrating the team's productivity and efficiency in delivering outcomes. This metric highlights the flow of work through the development process, indicating the team's ability to address and fulfill tasks and objectives effectively.",
            );
            expect(formattedData.category).toBe('Metric');

            if (formattedData.data.length > 0) {
                const firstDataPoint = formattedData.data[0];
                expect(firstDataPoint).toHaveProperty('period');
                expect(firstDataPoint).toHaveProperty('value');
                expect(firstDataPoint).toHaveProperty('comparison');
                expect(firstDataPoint.comparison).toBeInstanceOf(Array);
            }
        });

        it('should format lead time by column metric data correctly', () => {
            const metricsMock = getMockMetrics();

            const leadTimeByColumn =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                    metricsMock,
                );

            const formattedData =
                metricTrendAnalyzerAndFormatter.getLeadTimeByColumnMetricFormatted(
                    leadTimeByColumn,
                );

            expect(formattedData).toBeInstanceOf(Array);
            expect(formattedData.length).toBeGreaterThan(0);
            const leadTimeByColumnData = formattedData[0];

            expect(leadTimeByColumnData).toHaveProperty(
                'type',
                'Lead Time By Column',
            );
            expect(leadTimeByColumnData).toHaveProperty('category', 'Metric');
            expect(leadTimeByColumnData).toHaveProperty('description');
            expect(leadTimeByColumnData.description).toContain(
                'measures the average time that work items spend in each column of the board',
            );

            expect(Array.isArray(leadTimeByColumnData.data)).toBeTruthy();
            if (leadTimeByColumnData.data.length > 0) {
                const firstPeriodData = leadTimeByColumnData.data[0];
                expect(firstPeriodData).toHaveProperty('period');
                expect(firstPeriodData.period).toHaveProperty('start');
                expect(firstPeriodData.period).toHaveProperty('end');
                expect(firstPeriodData).toHaveProperty('columns');

                const columnNames = Object.keys(firstPeriodData.columns);
                if (columnNames.length > 0) {
                    const firstColumnName = columnNames[0];
                    const firstColumnData =
                        firstPeriodData.columns[firstColumnName];
                    expect(firstColumnData).toHaveProperty('leadTime');
                    if (firstColumnData.comparison) {
                        expect(firstColumnData.comparison).toHaveProperty(
                            'date',
                        );
                        expect(firstColumnData.comparison).toHaveProperty(
                            'change',
                        );
                        expect(firstColumnData.comparison).toHaveProperty(
                            'direction',
                        );
                    }
                }
            }
        });

        it('should format predicted delivery dates correctly', () => {
            const metricsMock = getMockMetrics();

            const predictedDeliveryDates =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.PREDICTED_DELIVERY_DATES,
                    metricsMock,
                );

            const formattedData =
                metricTrendAnalyzerAndFormatter.getPredictedDeliveryDatesFormatted(
                    predictedDeliveryDates,
                );

            expect(formattedData).toHaveProperty(
                'type',
                'Predicted Delivery Dates',
            );
            expect(formattedData).toHaveProperty('category', 'Forecast');
            expect(formattedData).toHaveProperty('description');
            expect(formattedData).toHaveProperty('currentDate');
            expect(formattedData).toHaveProperty('predictions');
            expect(Array.isArray(formattedData.predictions)).toBeTruthy();

            const firstPrediction = formattedData.predictions[0];
            expect(firstPrediction).toHaveProperty('issueKey');
            expect(firstPrediction).toHaveProperty('startDate');
            expect(firstPrediction.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // Checks the date format
            expect(firstPrediction).toHaveProperty('p75');
            expect(firstPrediction.p75).toMatch(/^\d{4}-\d{2}-\d{2}$/); // Checks the date format
            expect(firstPrediction).toHaveProperty('isLate');
            expect(firstPrediction).toHaveProperty('aging');
        });

        it('should format general lead time metric data correctly', () => {
            const metricsMock = getMockMetrics();

            const leadTime =
                metricTrendAnalyzerAndFormatter.analyzeMetricTrendsOverTime(
                    METRICS_TYPE.LEAD_TIME,
                    metricsMock,
                );

            const formattedData =
                metricTrendAnalyzerAndFormatter.getGeneralLeadTimeFormatted(
                    leadTime,
                );

            expect(formattedData).toHaveProperty('type', 'General Lead Time');
            expect(formattedData).toHaveProperty('category', 'Metric');
            expect(formattedData).toHaveProperty('description');
            expect(formattedData.description).toContain(
                'measures the time work items spend from start to completion',
            );
            expect(Array.isArray(formattedData.data)).toBeTruthy();
            expect(formattedData.data.length).toBeGreaterThan(0);

            const firstDataPoint = formattedData.data[0];
            expect(firstDataPoint).toHaveProperty('period');
            expect(firstDataPoint.period).toHaveProperty('start');
            expect(firstDataPoint.period).toHaveProperty('end');
            expect(firstDataPoint).toHaveProperty('value');

            if (formattedData.data.length > 1) {
                const secondDataPoint = formattedData.data[1];
                expect(secondDataPoint).toHaveProperty('comparison');
                if (secondDataPoint.comparison) {
                    expect(secondDataPoint.comparison).toHaveProperty(
                        'previousValue',
                    );
                    expect(secondDataPoint.comparison).toHaveProperty('change');
                    expect(secondDataPoint.comparison).toHaveProperty(
                        'direction',
                    );
                }
            }
        });
    });
});
