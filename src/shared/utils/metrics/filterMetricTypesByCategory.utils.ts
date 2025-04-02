import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

export function getMetricTypesByCategory(
    category?: METRICS_CATEGORY,
): ReadonlyArray<METRICS_TYPE> {
    if (!category || !Object.values(METRICS_CATEGORY).includes(category)) {
        return Object.values(METRICS_TYPE);
    }

    switch (category) {
        case METRICS_CATEGORY.FLOW_METRICS:
            return [
                METRICS_TYPE.LEAD_TIME,
                METRICS_TYPE.LEAD_TIME_IN_WIP,
                METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                METRICS_TYPE.THROUGHPUT,
                METRICS_TYPE.BUG_RATIO,
                METRICS_TYPE.LEAD_TIME_IN_WIP_BY_ITEM_TYPE,
                METRICS_TYPE.LEAD_TIME_BY_ITEM_TYPE,
                METRICS_TYPE.DELIVERY_CAPACITY,
            ];
        case METRICS_CATEGORY.DORA_METRICS:
            return [
                METRICS_TYPE.DEPLOY_FREQUENCY,
                METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
            ];
        default:
            return [];
    }
}
