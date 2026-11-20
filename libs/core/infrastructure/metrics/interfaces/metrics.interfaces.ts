export enum MetricType {
    COUNTER = 'counter',
    HISTOGRAM = 'histogram',
    GAUGE = 'gauge',
}

export interface MetricEvent {
    name: string;
    type: MetricType;
    value: number;
    labels: Record<string, string>;
    recordedAt: Date;
}

export type {
    ErrorRateResult,
    MetricsSummary,
    PipelinePerformanceResult,
    ResponseTimeResult,
} from '@libs/core/metrics/domain/metrics.types';
