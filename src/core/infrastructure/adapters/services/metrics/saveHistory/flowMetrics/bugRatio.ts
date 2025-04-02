import { BugRatioCalculator } from '../../processMetrics/bugRatio';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { WorkItem } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

class BugRatioHistory {
    public prepareDataToBulkCreate(params: {
        workItems: WorkItem[];
        columnsConfig: ColumnsConfigResult;
        bugTypeIdentifiers: any;
        startDate: Date;
        endDate: Date;
        teamId: string;
    }): IMetrics[] {
        const bugRatioMetrics: IMetrics[] = [];
        const bugRatioCalculator = new BugRatioCalculator();

        for (
            let currentDate = new Date(params.startDate);
            currentDate <= params.endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const simulatedWorkItems = this.simulateWorkItemsForDate(
                params.workItems,
                currentDate,
                params.columnsConfig,
            );

            bugRatioCalculator.setConfiguration(
                simulatedWorkItems,
                params.columnsConfig.wipColumns,
                params.bugTypeIdentifiers,
            );

            const dailyBugRatio = bugRatioCalculator.calculateBugRatioForAll();

            bugRatioMetrics.push({
                uuid: uuidv4(),
                team: { uuid: params.teamId },
                type: METRICS_TYPE.BUG_RATIO,
                value: dailyBugRatio,
                status: true,
                category: METRICS_CATEGORY.FLOW_METRICS,
                referenceDate: moment(currentDate).format(
                    'YYYY-MM-DD HH:mm:ss',
                ),
            } as IMetrics);
        }

        return bugRatioMetrics;
    }

    private simulateWorkItemsForDate(
        workItems: WorkItem[],
        date: Date,
        columnsConfig: ColumnsConfigResult,
    ): WorkItem[] {
        const simulatedColumns: { [key: string]: WorkItem } = {};

        columnsConfig.allColumns.forEach((column) => {
            simulatedColumns[column.id] = {
                columnName: column.name,
                columnId: column.id,
                workItems: [],
            };
        });

        let totalItemsProcessed = 0;
        let totalItemsIncluded = 0;

        workItems.forEach((column) => {
            column.workItems.forEach((item) => {
                totalItemsProcessed++;
                const itemDate = new Date(item.workItemCreatedAt);
                if (itemDate <= date) {
                    const columnOnDate = this.getColumnOnDate(
                        item,
                        date,
                        columnsConfig,
                    );
                    if (columnOnDate) {
                        simulatedColumns[columnOnDate.id].workItems.push({
                            ...item,
                            columnName: columnOnDate.name,
                            status: {
                                ...item.status,
                                name: columnOnDate.name,
                                id: columnOnDate.id,
                            },
                        });
                        totalItemsIncluded++;
                    }
                }
            });
        });

        const result = Object.values(simulatedColumns).filter(
            (column) => column.workItems.length > 0,
        );

        return result;
    }

    private getColumnOnDate(
        item: any,
        date: Date,
        columnsConfig: ColumnsConfigResult,
    ): { id: string; name: string } | null {
        const changelogOnDate = item.changelog
            .filter((log) => new Date(log.created) <= date)
            .sort(
                (a, b) =>
                    new Date(b.created).getTime() -
                    new Date(a.created).getTime(),
            );

        if (changelogOnDate.length > 0) {
            for (const log of changelogOnDate) {
                const statusMovement = log.movements.find(
                    (m) => m.field === 'status',
                );
                if (statusMovement) {
                    const column = columnsConfig.allColumns.find(
                        (c) => c.id === statusMovement.toColumnId,
                    );
                    if (column) {
                        return {
                            id: column.id,
                            name: column.name,
                        };
                    }
                }
            }
        }

        // If we don't find any status movement in the changelog up to the specified date,
        // we assume the item was in its original column (or the first column if it predates creation)
        if (new Date(item.workItemCreatedAt) <= date) {
            const column = columnsConfig.allColumns.find(
                (c) => c.id === item.status.id,
            );
            if (column) {
                return {
                    id: column.id,
                    name: column.name,
                };
            }
        }

        // If the item was created after the specified date, it should not be included
        return null;
    }
}

export { BugRatioHistory };
