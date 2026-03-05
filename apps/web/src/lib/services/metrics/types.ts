export interface Metric {
    name: string;
    result: string;
    difference: string;
    isPositive: boolean;
    title: string;
    howToAnalyze: string;
    layoutIndex: number;
    whatIsIt: string;
    resultObs: string;
    resultType: string;
}

export enum NewItemsFrom {
    TODO_COLUMN = "todo",
    CREATION_DATE = "creationDate",
}

export enum TeamExclusiveMetrics {
    FLOW_EFFICIENCY = "flowEfficiency",
    DELIVERY_CAPACITY = "deliveryCapacity",
}
