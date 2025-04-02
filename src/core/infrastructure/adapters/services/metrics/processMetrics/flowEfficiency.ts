import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import { getMetricPropertyByType } from '@/shared/infrastructure/services/metrics';
import { calculatePercentageDifference } from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

interface FormattedFlowEfficiency {
    date: string;
    chartDate: string;
    value: Omit<IOriginal, 'utcDate'>;
    waitingTime: { days: number; percentage: number };
    actionTime: { days: number; percentage: number };
    order: number;
}

interface IOriginal {
    [key: string]:
        | {
              days: number;
              percentage: number;
          }
        | string;
    utcDate: string;
}
interface IFlowEfficiencyMetric {
    date: string;
    description?: string;
    differences: any[];
    metricType: string;
    original: IOriginal;
    utcDate: string;
}

class FlowEfficiencyCalculator {
    formatFlowEfficiencyForTeamAndPeriod(
        metrics: IFlowEfficiencyMetric[],
        timezone = Timezone.DEFAULT_TIMEZONE,
        columnsConfig: (ColumnsConfigKey & { columnType?: string })[] = [],
    ): FormattedFlowEfficiency[] {
        return metrics
            .map((metric, index) => {
                const { waitingTime, actionTime } =
                    this.calculateColumnTotals(metric.original, columnsConfig);

                return {
                    date: moment(metric.utcDate)
                        .tz(timezone)
                        .format('DD/MM/YY'),
                    chartDate: moment(metric.date)
                        .tz(timezone)
                        .format('YYYY-MM-DD'),
                    value: Object.fromEntries(
                        Object.entries(metric.original).filter(
                            ([key]) => key !== 'utcDate',
                        ),
                    ),
                    waitingTime,
                    actionTime,
                    order: index + 1,
                };
            })
            .filter((item) => item !== null);
    }

    private calculateColumnTotals(
        originalData: IOriginal,
        columnsConfig: (ColumnsConfigKey & { columnType?: string })[],
    ) {
        let waitingDays = 0;
        let actionDays = 0;
        let totalDays = 0;

        Object.entries(originalData).forEach(([columnName, data]) => {
            if (columnName !== 'utcDate' && typeof data === 'object') {
                const columnConfig = columnsConfig.find(
                    (cc) => cc.name.toLowerCase() === columnName.toLowerCase(),
                );

                if (columnConfig?.column === 'wip') {
                    if (columnConfig.columnType === 'waiting') {
                        waitingDays += data.days;
                    } else {
                        actionDays += data.days;
                    }
                    totalDays += data.days;
                }
            }
        });

        return {
            waitingTime: {
                days: Number(waitingDays.toFixed(2)),
                percentage: Number(
                    (totalDays > 0
                        ? (waitingDays / totalDays) * 100
                        : 0
                    ).toFixed(2),
                ),
            },
            actionTime: {
                days: Number(actionDays.toFixed(2)),
                percentage: Number(
                    (totalDays > 0
                        ? (actionDays / totalDays) * 100
                        : 0
                    ).toFixed(2),
                ),
            },
        };
    }

    processFlowEfficiencyForCockpit(
        data: any,
        waitingTime?: ColumnsConfigKey[],
    ) {
        const flowEfficiency = data.flowEfficiency;

        if (flowEfficiency.length > 1) {
            const currentWeek = this.calculateWeekEfficiency(
                this.addColumnCategories(
                    flowEfficiency[1].original,
                    waitingTime,
                ),
            );
            const previousWeek = this.calculateWeekEfficiency(
                this.addColumnCategories(
                    flowEfficiency[0].original,
                    waitingTime,
                ),
            );

            const { percentageDifference, realDifference } =
                calculatePercentageDifference(
                    previousWeek.efficiency,
                    currentWeek.efficiency,
                );

            return {
                name: METRICS_TYPE.FLOW_EFFICIENCY,
                title: 'Flow Efficiency',
                result: currentWeek.efficiency.toFixed(2) + '%',
                resultObs: `${currentWeek.wipTime.toFixed(2)} days in WIP, ${currentWeek.waitingTime.toFixed(2)} days on hold`,
                resultType:
                    realDifference === 0
                        ? 'Same'
                        : currentWeek.efficiency > previousWeek.efficiency
                          ? 'Positive'
                          : 'Negative',
                difference: percentageDifference,
                howToAnalyze: getMetricPropertyByType(
                    'flowEfficiency',
                    'explanationForTeams',
                ),
                whatIsIt: getMetricPropertyByType('flowEfficiency', 'whatIsIt'),
                layoutIndex: 5,
            };
        }
    }

    private addColumnCategories(
        weekData: any,
        waitingTime?: ColumnsConfigKey[],
    ): Record<string, any> {
        if (!waitingTime) return weekData;

        const waitingColumnNames = waitingTime.map((col) =>
            col.name.toLowerCase(),
        );

        return Object.entries(weekData).reduce(
            (acc, [columnName, columnData]) => {
                if (typeof columnData === 'object' && columnData !== null) {
                    acc[columnName] = {
                        ...(columnData as object),
                        columnCategory: waitingColumnNames.includes(
                            columnName.toLowerCase(),
                        )
                            ? 'Waiting'
                            : 'Action',
                    };
                } else {
                    acc[columnName] = {
                        columnCategory: waitingColumnNames.includes(
                            columnName.toLowerCase(),
                        )
                            ? 'Waiting'
                            : 'Action',
                        ...(typeof columnData === 'object'
                            ? columnData
                            : { value: columnData }),
                    };
                }
                return acc;
            },
            {} as Record<string, any>,
        );
    }

    private calculateWeekEfficiency(weekData: any) {
        let wipTime = 0;
        let waitingTime = 0;

        Object.entries(weekData).forEach(
            ([columnName, columnData]: [string, any]) => {
                if (columnData.columnCategory === 'Action') {
                    wipTime += columnData.days;
                } else if (columnData.columnCategory === 'Waiting') {
                    waitingTime += columnData.days;
                }
            },
        );

        const totalTime = wipTime + waitingTime;
        const efficiency = totalTime > 0 ? (wipTime / totalTime) * 100 : 0;

        return { efficiency, wipTime, waitingTime };
    }
}

export { FlowEfficiencyCalculator };
