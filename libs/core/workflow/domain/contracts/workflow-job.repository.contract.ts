import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

export interface StaleWorkflowJobReapResult {
    uuid: string;
    workflowType: string;
    organizationId: string | null;
    startedAt: Date | null;
}

export interface IWorkflowJobRepository {
    create(job: any, transactionManager?: unknown): Promise<any>;
    update(id: string, data: any): Promise<any>;
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
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
