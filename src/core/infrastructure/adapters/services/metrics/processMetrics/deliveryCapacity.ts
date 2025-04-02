import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import { getMetricPropertyByType } from '@/shared/infrastructure/services/metrics';
import {
    calculatePercentagePointDifference,
} from '@/shared/utils/transforms/math';
import * as moment from 'moment-timezone';

export enum NewItemsFrom {
    TODO_COLUMN = 'todo',
    CREATION_DATE = 'creationDate',
}

class DeliveryCapacityCalculator {
    private columns: any[];
    private todoColumns: string[];
    private throughputData: any[];

    setConfiguration(
        columns: any[],
        todoColumns: string[],
        throughputData: any[],
    ) {
        this.columns = columns;
        this.todoColumns = todoColumns;
        this.throughputData = throughputData;
    }

    calculateDeliveryCapacity(date: Date): {
        deliveryCapacityFromTodo: {
            newTodoItems: number;
            deliveredItems: number;
            deliveryRate: number;
        };
        deliveryCapacityFromCreation: {
            newItems: number;
            deliveredItems: number;
            deliveryRate: number;
        };
    } {
        const startOfDay = moment(date).startOf('day').toDate();
        const endOfDay = moment(date).endOf('day').toDate();

        let newTodoItems = 0;
        let newItems = 0;

        for (const column of this.columns) {
            for (const workItem of column.workItems) {
                const createdAt = new Date(workItem.workItemCreatedAt);
                if (createdAt >= startOfDay && createdAt <= endOfDay) {
                    newItems++;
                }

                for (const entry of workItem.changelog) {
                    for (const movement of entry.movements) {
                        if (
                            movement.field === 'status' &&
                            this.todoColumns.includes(movement.toColumnId) &&
                            !this.todoColumns.includes(movement.fromColumnId)
                        ) {
                            const transitionDate = new Date(entry.created);
                            if (
                                transitionDate >= startOfDay &&
                                transitionDate <= endOfDay
                            ) {
                                newTodoItems++;
                                break;
                            }
                        }
                    }
                }
            }
        }

        const deliveredItems = this.getThroughputForDate(date);

        const deliveryRateFromTodo =
            newTodoItems > 0 && deliveredItems > 0
                ? (deliveredItems / newTodoItems) * 100
                : 0;
        const deliveryRateFromCreation =
            newItems > 0 && deliveredItems > 0
                ? (deliveredItems / newItems) * 100
                : 0;

        return {
            deliveryCapacityFromTodo: {
                newTodoItems,
                deliveredItems,
                deliveryRate: Number(deliveryRateFromTodo.toFixed(2)),
            },
            deliveryCapacityFromCreation: {
                newItems,
                deliveredItems,
                deliveryRate: Number(deliveryRateFromCreation.toFixed(2)),
            },
        };
    }

    private getThroughputForDate(date: Date): number {
        const formattedDate = moment(date).format('YYYY-MM-DD');
        const throughputEntry = this.throughputData.find(
            (entry) =>
                moment(entry.referenceDate).format('YYYY-MM-DD') ===
                formattedDate,
        );
        return throughputEntry?.value?.value ?? 0;
    }

    formatDeliveryCapacityForTeamAndPeriod(
        data: any[],
        newItemsFrom: NewItemsFrom,
        timezone = Timezone.DEFAULT_TIMEZONE,
    ) {
        return data.map((metric, index) => {
            const date = moment(metric?.utcDate).tz(timezone);
            const source =
                newItemsFrom === NewItemsFrom.TODO_COLUMN
                    ? 'deliveryCapacityFromTodo'
                    : 'deliveryCapacityFromCreation';

            const deliveredItems = metric.original[source].deliveredItems;
            const newItems =
                metric.original[source][
                    newItemsFrom === NewItemsFrom.TODO_COLUMN
                        ? 'newTodoItems'
                        : 'newItems'
                ];

            const deliveryRate =
                newItems !== 0 ? (deliveredItems / newItems) * 100 : 0;

            return {
                date: date.format('DD/MM/YYYY'),
                chartDate: date.format('YYYY-MM-DD'),
                deliveredItems,
                newItems,
                deliveryRate: Number(deliveryRate.toFixed(2)),
                order: index + 1,
            };
        });
    }

    processDeliveryCapacityDataForCockpit(
        data: any,
        newItemsFrom: NewItemsFrom,
    ) {
        if (!data.deliveryCapacity || data.deliveryCapacity.length < 2) {
            return null;
        }

        const recent = data.deliveryCapacity[1];
        const previous = data.deliveryCapacity[0];

        const sourceKey =
            newItemsFrom === NewItemsFrom.TODO_COLUMN
                ? 'deliveryCapacityFromTodo'
                : 'deliveryCapacityFromCreation';
        const newItemsKey =
            newItemsFrom === NewItemsFrom.TODO_COLUMN
                ? 'newTodoItems'
                : 'newItems';

        const recentDeliveryRate = this.calculateDeliveryRate(
            recent.original[sourceKey].deliveredItems,
            recent.original[sourceKey][newItemsKey],
        );
        const previousDeliveryRate = this.calculateDeliveryRate(
            previous.original[sourceKey].deliveredItems,
            previous.original[sourceKey][newItemsKey],
        );

        let percentageDifference = calculatePercentagePointDifference(
            previousDeliveryRate,
            recentDeliveryRate,
        );

        const resultType =
            !percentageDifference || percentageDifference === '0%'
                ? 'Same'
                : recentDeliveryRate > previousDeliveryRate
                  ? 'Positive'
                  : 'Negative';

        return {
            name: METRICS_TYPE.DELIVERY_CAPACITY,
            title: `Delivery Capacity`,
            result: `${recentDeliveryRate.toFixed(2)}%`,
            resultObs: `${recent.original[sourceKey].deliveredItems} of ${recent.original[sourceKey][newItemsKey]} items delivered`,
            resultType,
            difference: percentageDifference,
            howToAnalyze: getMetricPropertyByType(
                'deliveryCapacity',
                'explanationForTeams',
            ),
            whatIsIt: getMetricPropertyByType('deliveryCapacity', 'whatIsIt'),
            layoutIndex: 4,
        };
    }

    private calculateDeliveryRate(
        deliveredItems: number,
        newItems: number,
    ): number {
        const rate =
            newItems === 0
                ? deliveredItems > 0
                    ? 100
                    : 0
                : (deliveredItems / newItems) * 100;
        return Math.min(rate, 100);
    }
}

export { DeliveryCapacityCalculator };
