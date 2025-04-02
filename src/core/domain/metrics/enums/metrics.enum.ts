export enum METRICS_TYPE {
    LEAD_TIME = 'leadTime',
    CYCLE_TIME = 'cycleTime',
    LEAD_TIME_IN_WIP = 'leadTimeInWip',
    LEAD_TIME_BY_COLUMN = 'leadTimeByColumn',
    THROUGHPUT = 'throughput',
    BUG_RATIO = 'bugRatio',
    PREDICTED_DELIVERY_DATES = 'predictedDeliveryDates',
    LEAD_TIME_IN_WIP_BY_ITEM_TYPE = 'leadTimeInWipByItemType',
    LEAD_TIME_BY_ITEM_TYPE = 'leadTimeByItemType',
    DELIVERY_CAPACITY = 'deliveryCapacity',
    FLOW_EFFICIENCY = 'flowEfficiency',

    //Dora Metrics
    DEPLOY_FREQUENCY = 'deployFrequency',
    LEAD_TIME_FOR_CHANGE = 'leadTimeForChange',
}
