/** What the internal metrics endpoints return. */
export interface ErrorRateResult {
    component: string;
    totalRequests: number;
    totalErrors: number;
    errorRate: number;
    windowMinutes: number;
}

export interface ResponseTimeResult {
    p50: number;
    p95: number;
    avg: number;
    max: number;
    count: number;
    windowHours: number;
}

export interface PipelinePerformanceResult {
    pipeline: string;
    stage: string;
    avgDurationMs: number;
    count: number;
}

export interface MetricsSummary {
    errorRate: ErrorRateResult[];
    reviewsProcessed: number;
    reviewsFailed: number;
    avgReviewDurationMs: number;
    timestamp: string;
}
