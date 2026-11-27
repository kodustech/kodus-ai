import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

export interface StaleWorkflowJobReapResult {
    uuid: string;
    workflowType: string;
    organizationId: string | null;
    startedAt: Date | null;
    /** To name the PR the reaped job was about. */
    payload?: Record<string, unknown> | null;
}

export interface IWorkflowJobRepository {
    create(job: any, transactionManager?: unknown): Promise<any>;
    update(
        id: string,
        data: any,
        expectedStatus?: JobStatus | JobStatus[],
        expectedAttemptId?: string,
    ): Promise<any>;
    findOne(id: string): Promise<any>;
    findMany(query: any): Promise<{ data: any[]; total?: number }>;
    prunePayloadForFinalizedJobs?(params: {
        olderThan: Date;
        limit?: number;
    }): Promise<number>;
    /**
     * Reaps jobs orphaned in PROCESSING (worker SIGKILLed before any
     * terminal update). Flips PROCESSING rows whose updatedAt is older than
     * `olderThan` to FAILED and returns the reaped rows for logging.
     */
    failStaleProcessing?(params: {
        olderThan: Date;
        lastError: string;
        errorClassification: unknown;
    }): Promise<StaleWorkflowJobReapResult[]>;
    /**
     * Cancels PENDING and PROCESSING jobs of one workflow run. The status
     * filter is in the UPDATE itself, so a job that finished between the
     * scan cancel and this write is left alone.
     */
    cancelActiveByCorrelation(params: {
        correlationId: string;
        workflowType: string;
    }): Promise<number>;
    /**
     * Deletes one batch of finished jobs last updated before `olderThan`
     * that no inbox/outbox message references, except `keepWorkflowTypes`.
     * Returns how many went and where the next batch should resume.
     */
    deleteFinishedOlderThan(params: {
        olderThan: Date;
        batchSize: number;
        after?: string;
        afterId?: string;
        keepWorkflowTypes?: string[];
    }): Promise<{
        deleted: number;
        /** Rows the batch read; fewer than `batchSize` means nothing is left. */
        candidates: number;
        lastUpdatedAt?: string;
        lastId?: string;
    }>;
    /**
     * FAILED only while the row is still PROCESSING. Returns whether a row
     * was updated. A COMPLETED / CANCELLED / FAILED job is left alone.
     */
    failIfProcessing(
        id: string,
        data: {
            lastError: string;
            errorClassification: ErrorClassification;
        },
    ): Promise<boolean>;
    /** Jobs failed by a reaper since `since` (lastError starts with the prefix). */
    /** Jobs the reapers failed in the last `windowMinutes` (DB clock). */
    countReapedSince?(
        windowMinutes: number,
        lastErrorPrefix: string,
    ): Promise<number>;
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
