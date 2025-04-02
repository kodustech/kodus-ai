export interface BugRatio {
    value: number;
    totalWorkItems: number;
    totalBugs: number;
}

interface LeadTime {
    [key: string]: {
        [key: string]: number;
    };
}

interface LeadTimeByColumn {
    [key: string]: number;
}

interface LeadTimeInWip {
    average: number;
    percentiles: Percentile;
    issues: { key: string; average: number }[];
    total: {
        average: number;
        percentiles: {
            p50: number;
            p75: number;
            p85: number;
            p95: number;
        };
    };
}

export interface Percentile {
    p50: number;
    p75: number;
    p85: number;
    p95: number;
}

export interface FlowMetricsResults {
    leadTime: LeadTime;
    leadTimeByColumn: LeadTimeByColumn;
    leadTimeInWip: LeadTimeInWip;
    leadTimeInWipByItemType: any;
    leadTimeByItemType: any;
    throughput: number;
    bugRatio: BugRatio;
}

export interface DoraMetricsResults {
    deployFrequency: any;
    leadTimeForChange: any;
}

export enum MetricsConversionStructure {
    METRICS_TREND = 'metricsTrend',
    I_METRICS = 'iMetrics',
}

export enum LeadTimeByColumnUnity {
    HOURS = 'hours',
    DAYS = 'days',
    PERCENTAGE = 'percentage',
    HOURS_AND_PERCENTAGE = 'hoursAndPercentage',
    DAYS_AND_PERCENTAGE = 'daysAndPercentage',
}

export type TeamMetricsConfig = {
    analysisPeriod?: {
        startTime: Date;
        endTime: Date;
    };
    considerAll?: boolean;
    howManyHistoricalDays?: number;
    weekDay?: number;
    daysInterval?: number;
    howManyMetricsInThePast?: number;
    leadTimeByColumnUnity?: LeadTimeByColumnUnity;
};
