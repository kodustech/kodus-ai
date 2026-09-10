export interface StaleWorkflowJobReapResult {
    uuid: string;
    workflowType: string;
    organizationId: string | null;
    startedAt: Date | null;
    leaseExpiresAt?: Date | null;
    retryCount?: number;
    maxRetries?: number;
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
     * Lists PROCESSING jobs owned by a dead/slow worker (issue #1830): rows
     * whose lease is EXPIRED (`leaseExpiresAt < now`) — a renewed lease means
     * the worker is alive and the job is left alone — OR, for legacy rows that
     * pre-date the lease, rows whose updatedAt is older than `olderThan`. This
     * lets the reaper detect a dead worker in ~90s instead of the 180-min
     * in-process timeout that dies with the process.
     */
    findStaleProcessing?(params: {
        now: Date;
        olderThan: Date;
    }): Promise<StaleWorkflowJobReapResult[]>;
    /**
     * Returns a reclaimed job to PENDING with retryCount incremented and the
     * lease/run state cleared so a fresh trigger re-processes it, instead of
     * permanently failing it.
     */
    requeueStaleJobs?(params: {
        uuids: string[];
        lastError: string;
        requeuedBy: string;
    }): Promise<number>;
    /**
     * Terminally fails reclaimed jobs whose retry budget is exhausted.
     */
    failStaleJobs?(params: {
        uuids: string[];
        lastError: string;
        errorClassification: unknown;
    }): Promise<number>;
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
