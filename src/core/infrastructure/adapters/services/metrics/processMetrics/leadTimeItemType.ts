import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import * as moment from 'moment-timezone';

interface Percentiles {
    p50: number;
    p75: number;
    p95: number;
}

interface IssueTypeData {
    sum: number;
    average: number;
    percentiles: Percentiles;
    percentageOfTotal: number;
}

// Now accepts any string as a key
interface IssuesTypes {
    [key: string]: IssueTypeData;
}

interface Original {
    IssuesTypes: IssuesTypes;
}

interface MetricData {
    metricType: string;
    date: string;
    original: Original;
    differences: any[];
    description?: string;
    utcDate: string;
}

interface WorkItem {
    workItemType: string;
    hours: number;
    days: number;
}

interface FormattedMetric {
    date: string;
    chartDate: string;
    result: WorkItem[];
    order: number;
}

class LeadTimeItemTypeCalculator {
    private validTypes: Set<string>;
    private columns: any[];
    private metricLeadTime: { issues: any[] };
    private workItemTypes: WorkItemType[];

    setConfiguration(
        columns: any[],
        metricLeadTime: { issues: any[] },
        workItemTypes: WorkItemType[],
    ) {
        this.columns = columns;
        this.metricLeadTime = metricLeadTime;
        this.workItemTypes = workItemTypes;
        this.validTypes = new Set(workItemTypes.map((type) => type.name));
    }

    /**
     * Calculates the bug ratio based on the total number of bugs and issues.
     *
     * @return {number} The bug ratio as a decimal value.
     */

    calculateLeadTimeByItemTypeForAll(): {
        IssuesTypes: { [key: string]: any };
    } {
        const tasksAndTotalTime = {};

        this.metricLeadTime.issues.forEach((issue) => {
            const key = Object.keys(issue)[0];
            const details = issue[key];
            tasksAndTotalTime[key] = Object.entries(details)
                .filter(([columnType]) => columnType !== 'Done')
                .reduce((total, pair) => total + Number(pair[1]), 0);
        });

        return this.calcResult(tasksAndTotalTime);
    }

    calculateLeadTimeInWipByItemTypeForAll(
        wipColumnIds?: string[],
        allColumns?: any[],
    ) {
        const tasksAndTotalTime = {};

        const wipColumnsName = allColumns
            .filter((column) => wipColumnIds.includes(column.id))
            .map((column) => column.name);

        this.metricLeadTime.issues.forEach((issue) => {
            const key = Object.keys(issue)[0];
            const details = issue[key];

            tasksAndTotalTime[key] = Object.entries(details).reduce(
                (total, [columnId, timeSpent]) => {
                    return new Set(wipColumnsName).has(columnId)
                        ? total + Number(timeSpent)
                        : total;
                },
                0,
            );
        });

        return this.calcResult(tasksAndTotalTime);
    }

    calcResult(tasksAndTotalTime: { [x: string]: any }) {
        const typesAndTasks = {};

        for (const column of this.columns) {
            for (const workItem of column.workItems) {
                const typeName = workItem.workItemType.originalName;
                const taskKey = workItem.key;
                if (!this.validTypes.has(typeName)) continue;

                if (!typesAndTasks[typeName]) {
                    typesAndTasks[typeName] = [];
                }
                typesAndTasks[typeName].push(taskKey);
            }
        }

        const typeIssuesList: any[] = Object.entries(typesAndTasks).map(
            ([type, tasks]) => ({
                [type]: tasks,
            }),
        );

        const mappedIssues = typeIssuesList.map((issue) => {
            const issueKey = Object.keys(issue)[0];
            const issueValues = issue[issueKey];
            const detailedValues = issueValues.map((id: string) => {
                return { id, value: tasksAndTotalTime[id] || 0 };
            });
            return { category: issueKey, tasks: detailedValues };
        });

        const results = { IssuesTypes: {} };

        let sumOfAll = 0;

        mappedIssues.forEach((issue) => {
            results.IssuesTypes[issue.category] = this.calculateMetrics(
                issue.tasks,
            );
            sumOfAll += results.IssuesTypes[issue.category].sum;
        });

        Object.values(results.IssuesTypes).forEach(
            (issue: { sum: number; percentageOfTotal?: number }) => {
                issue.percentageOfTotal = parseFloat(
                    ((issue.sum / sumOfAll) * 100).toFixed(2),
                );
                issue.sum = parseFloat(issue.sum.toFixed(2));
            },
        );

        return results;
    }

    calculatePercentile(values: number[], percentile: number): number {
        values.sort((a, b) => a - b);
        const index = (percentile / 100) * (values.length - 1);
        if (Math.floor(index) === index) {
            return values[index];
        }
        const lower = values[Math.floor(index)];
        const upper = values[Math.ceil(index)];
        return lower + (upper - lower) * (index - Math.floor(index));
    }

    calculateMetrics(tasks: any[]): {
        average: number;
        percentiles: any;
        sum: number;
    } {
        const values = tasks.map((task) => task.value);
        const sum = values.reduce((a, b) => a + b, 0);
        const average = sum / values.length;
        const percentiles = {
            p50: this.calculatePercentile(values, 50),
            p75: this.calculatePercentile(values, 75),
            p95: this.calculatePercentile(values, 95),
        };
        return { average, percentiles, sum };
    }

    processAndAppendData(
        leadTimeData: any,
        organizationParameters: any,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        const groupedResults = {};

        leadTimeData.forEach((dataItem) => {
            const issuesTypes = dataItem.original.IssuesTypes;
            organizationParameters?._configValue?.categorizedWorkItemTypes?.forEach(
                (category) => {
                    category?.workItemsTypes?.forEach((workItemType) => {
                        const leadTimeItem = issuesTypes[workItemType.name];
                        if (leadTimeItem) {
                            const formattedDate = moment(dataItem.utcDate)
                                .tz(timezone)
                                .format('DD/MM/YYYY');
                            if (!groupedResults[formattedDate]) {
                                groupedResults[formattedDate] = {
                                    date: formattedDate,
                                    itemsTypes: {},
                                };
                            }
                            if (
                                !groupedResults[formattedDate].itemsTypes[
                                    category.category
                                ]
                            ) {
                                groupedResults[formattedDate].itemsTypes[
                                    category.category
                                ] = 0;
                            }
                            groupedResults[formattedDate].itemsTypes[
                                category.category
                            ] += leadTimeItem.sum;
                        }
                    });
                },
            );
        });

        const results = Object.values(groupedResults).map(
            (entry: {
                date: string;
                itemsTypes: { [key: string]: number };
            }) => {
                const itemsTypesArray = [];
                let dateTotal = 0;
                Object.keys(entry.itemsTypes).forEach((category) => {
                    dateTotal += entry.itemsTypes[category];
                });
                Object.keys(entry.itemsTypes).forEach((category) => {
                    if (entry.itemsTypes[category] > 0) {
                        itemsTypesArray.push({
                            category: category,
                            total: entry.itemsTypes[category],
                            percentageOfTotal: (
                                (entry.itemsTypes[category] / dateTotal) *
                                100
                            ).toFixed(2),
                        });
                    }
                });
                return { date: entry.date, itemsTypes: itemsTypesArray };
            },
        );

        return results;
    }

    formatLeadTimeInWipByItemTypeForTeamAndPeriod(
        data: MetricData[],
        timezone = Timezone.DEFAULT_TIMEZONE,
    ): FormattedMetric[] {
        return data.map((metric, index) => {
            const issueTypes = metric.original.IssuesTypes;

            const workItems: WorkItem[] = Object.entries(issueTypes).map(
                ([type, data]) => ({
                    workItemType: type,
                    hours: data.percentiles.p75,
                    days: Number((data.percentiles.p75 / 24).toFixed(2)),
                }),
            );

            return {
                date: moment(metric?.utcDate).tz(timezone).format('DD/MM/YY'),
                chartDate: moment(metric?.utcDate)
                    .tz(timezone)
                    .format('YYYY-MM-DD'),
                result: workItems,
                order: index + 1,
            };
        });
    }
}

export { LeadTimeItemTypeCalculator };
