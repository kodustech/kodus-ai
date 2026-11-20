export const METRICS_REPOSITORY_TOKEN = Symbol('MetricsRepository');

export interface HttpCountByComponent {
    component: string;
    name: string;
    count: number;
}

export interface StageDuration {
    pipeline?: string;
    stage?: string;
    avgDurationMs: number;
    count: number;
}

/** Reads of the observability metrics the internal metrics endpoints serve. */
export interface IMetricsRepository {
    /** `http_errors_total` and `http_request_total` summed per component. */
    sumHttpCountsByComponent(since: Date): Promise<HttpCountByComponent[]>;
    /** Every `code_review_duration_ms` value recorded since `since`. */
    findReviewDurations(since: Date): Promise<number[]>;
    /** How many `code_review_errors_total` events were recorded. */
    countReviewErrors(since: Date): Promise<number>;
    /** Average `pipeline_stage_duration_ms` per pipeline and stage. */
    averageStageDurations(since: Date): Promise<StageDuration[]>;
}
